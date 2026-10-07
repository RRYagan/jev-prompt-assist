import { describe, expect, test } from "bun:test"
import { countWords, isProcedural, lintSte, RULE_COVERAGE } from "../lib/tui/style"
import { emptySteData, type SteData } from "../lib/tui/ste100"

function data(): SteData {
  const d = emptySteData()
  d.loaded = true
  d.nonApproved.set("utilize", { word: "utilize", useInstead: ["USE (v)"] })
  d.approved.add("use")
  return d
}

function rules(text: string, opts: Parameters<typeof lintSte>[1] = { data: data() }): string[] {
  return lintSte(text, opts).map((issue) => issue.rule)
}

describe("lintSte word rules", () => {
  test("non-approved word offers a fix (1.1)", () => {
    const issues = lintSte("You must utilize the tool.", { data: data() })
    const issue = issues.find((i) => i.rule === "1.1")
    expect(issue).toBeDefined()
    expect(issue?.replacement).toBe("use")
    expect(issue?.severity).toBe("warn")
  })

  test("glossary suppresses a non-approved word", () => {
    const issues = lintSte("You must utilize the tool.", {
      data: data(),
      glossary: new Set(["utilize"]),
    })
    expect(issues.find((i) => i.rule === "1.1")).toBeUndefined()
  })

  test("contraction offers the expansion (4.2)", () => {
    const issues = lintSte("Don't move it.", { data: data() })
    const issue = issues.find((i) => i.rule === "4.2")
    expect(issue?.replacement).toBe("Do not")
  })

  test("Latin abbreviations (GR-6)", () => {
    const issues = lintSte("Use red, green, etc.", { data: data() })
    expect(issues.find((i) => i.rule === "GR-6")).toBeDefined()
  })

  test("British spelling (1.14)", () => {
    const issues = lintSte("The colour is red.", { data: data() })
    const issue = issues.find((i) => i.rule === "1.14")
    expect(issue?.replacement).toBe("color")
  })

  test("‘-ing’ form is advisory but approved -ing words are skipped (3.5)", () => {
    expect(rules("We are running the test.", { data: data() })).toContain("3.5")
    const withApproved = data()
    withApproved.approved.add("lighting")
    expect(rules("The lighting is off.", { data: withApproved })).not.toContain("3.5")
    expect(rules("The missing part is here.", { data: data() })).not.toContain("3.5")
  })

  test("passive voice with an agent is a hard warning (3.6)", () => {
    const issue = lintSte("The valve is installed by the crew.", { data: data() }).find(
      (i) => i.rule === "3.6",
    )
    expect(issue?.severity).toBe("warn")
  })

  test("semicolons are flagged (8.1)", () => {
    expect(rules("Open it; then close it.", { data: data() })).toContain("8.1")
  })
})

describe("lintSte sentence rules", () => {
  test("long procedural sentence (5.1)", () => {
    const text =
      "Add the bolt to the flange and then continue with the next step of the procedure before you start the test of the unit."
    expect(rules(text, { data: data() })).toContain("5.1")
  })

  test("limit caps the number of findings", () => {
    const issues = lintSte("utilize utilise utilize; don't", { data: data(), limit: 1 })
    expect(issues.length).toBe(1)
  })
})

describe("countWords (Rules 8.4-8.7)", () => {
  test("parenthetical counts as one", () => {
    expect(countWords("(the valve)")).toBe(1)
  })
  test("quoted text counts as one", () => {
    expect(countWords('Touch the "Service Overview" arrow to select the function page.')).toBe(9)
  })
  test("number+unit counts as one", () => {
    expect(countWords("The unit weighs 20 kg.")).toBe(4)
  })
})

describe("isProcedural", () => {
  test("imperative and list items are procedural", () => {
    expect(isProcedural("Add the bolt.")).toBe(true)
    expect(isProcedural("- Remove the pin.")).toBe(true)
    expect(isProcedural("If the light comes on, stop.")).toBe(true)
  })
  test("descriptions and notes are not", () => {
    expect(isProcedural("The system is stable.")).toBe(false)
    expect(isProcedural("NOTE: The system is stable.")).toBe(false)
  })
})

describe("RULE_COVERAGE", () => {
  test("accounts for all 53 Issue 9 rules plus 8 general recommendations", () => {
    const counts: Record<number, number> = { 1: 14, 2: 2, 3: 7, 4: 5, 5: 5, 6: 6, 7: 3, 8: 7, 9: 4 }
    const ids: string[] = []
    for (const [section, n] of Object.entries(counts)) {
      for (let i = 1; i <= n; i++) ids.push(`${section}.${i}`)
    }
    expect(ids.length).toBe(53)
    for (const id of ids) expect(RULE_COVERAGE[id], `missing rule ${id}`).toBeDefined()
    for (let i = 1; i <= 8; i++) expect(RULE_COVERAGE[`GR-${i}`]).toBeDefined()
    const valid = new Set(["auto", "advisory", "manual"])
    for (const value of Object.values(RULE_COVERAGE)) expect(valid.has(value)).toBe(true)
    // Spot-check the mechanical rules we actually implement.
    expect(RULE_COVERAGE["1.1"]).toBe("auto")
    expect(RULE_COVERAGE["4.2"]).toBe("auto")
    expect(RULE_COVERAGE["5.1"]).toBe("advisory")
  })
})
