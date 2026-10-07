import { describe, expect, test } from "bun:test"
import { lintGrammar } from "../lib/tui/grammar"

function rules(text: string): string[] {
  return lintGrammar(text).map((issue) => issue.rule)
}

describe("lintGrammar", () => {
  test("repeated words (GM-repeat)", () => {
    const issue = lintGrammar("This is is a test.").find((i) => i.rule === "GM-repeat")
    expect(issue).toBeDefined()
    expect(issue?.replacement).toBe("is")
  })

  test("its' -> its (GM-its)", () => {
    const issue = lintGrammar("The unit lost its' cover.").find((i) => i.rule === "GM-its")
    expect(issue?.replacement).toBe("its")
  })

  test("comparative then -> than (GM-then)", () => {
    const issue = lintGrammar("The new value is more then the old one.").find((i) => i.rule === "GM-then")
    expect(issue?.replacement).toBe("than")
  })

  test("effect/affect (GM-affect)", () => {
    const verb = lintGrammar("This will effect the result.").find((i) => i.rule === "GM-affect")
    expect(verb?.replacement).toBe("affect")
    const noun = lintGrammar("The the affect is small.").find((i) => i.rule === "GM-affect")
    expect(noun?.replacement).toBe("effect")
  })

  test("a/an agreement (GM-a-an)", () => {
    expect(lintGrammar("This is a apple.").find((i) => i.rule === "GM-a-an")?.replacement).toBe("an")
    expect(lintGrammar("This is an user error.").find((i) => i.rule === "GM-a-an")?.replacement).toBe("a")
    expect(rules("Wait an hour.")).not.toContain("GM-a-an")
  })

  test("sentence capital (GM-capital)", () => {
    const issue = lintGrammar("this is a test.").find((i) => i.rule === "GM-capital")
    expect(issue?.replacement).toBe("T")
  })

  test("double space (GM-space)", () => {
    const issue = lintGrammar("a  b").find((i) => i.rule === "GM-space")
    expect(issue?.replacement).toBe(" ")
  })

  test("unmatched bracket (GM-bracket)", () => {
    expect(rules("Open the valve (10.")).toContain("GM-bracket")
  })

  test("misspelling (GM-spelling)", () => {
    const issue = lintGrammar("Please recieve the part.").find((i) => i.rule === "GM-spelling")
    expect(issue?.replacement).toBe("receive")
  })

  test("correct text yields no findings", () => {
    expect(lintGrammar("This is a correct sentence.")).toHaveLength(0)
  })

  test("limit caps the findings", () => {
    expect(lintGrammar("recieve recieve recieve", { limit: 1 })).toHaveLength(1)
  })
})
