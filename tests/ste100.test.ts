import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyCase, cleanReplacement, loadSteData, normalizeWord } from "../lib/tui/ste100"

describe("ste100 normalization", () => {
  test("strips parentheticals and punctuation", () => {
    expect(normalizeWord("Few (a few)")).toBe("few")
    expect(normalizeWord("AFT OF (prep)")).toBe("aft of")
    expect(normalizeWord("  Don’t! ")).toBe("don’t")
  })

  test("cleanReplacement strips the part-of-speech annotation", () => {
    expect(cleanReplacement("USE (v)")).toBe("USE")
    expect(cleanReplacement("GO (v)")).toBe("GO")
  })

  test("applyCase copies the sample casing", () => {
    expect(applyCase("utilize", "use")).toBe("use")
    expect(applyCase("Utilize", "use")).toBe("Use")
    expect(applyCase("UTILIZE", "use")).toBe("USE")
  })
})

describe("loadSteData", () => {
  const dir = mkdtempSync(join(tmpdir(), "ste100-"))
  const dict = join(dir, "dictionary.json")
  const gloss = join(dir, "glossary.txt")
  writeFileSync(
    dict,
    JSON.stringify({
      source: "test",
      approved: [
        { word: "USE", pos: "v", forms: "USES, USED, USED" },
        { word: "VALVE", pos: "n" },
      ],
      non_approved: [{ word: "utilize", pos: "v", use_instead: ["USE (v)"] }],
    }),
  )
  writeFileSync(gloss, "# comment\nbreaker\nterminal block\n")
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  test("loads approved surface forms and non-approved entries", () => {
    const data = loadSteData({ dictionary: dict, glossary: gloss })
    expect(data.loaded).toBe(true)
    expect(data.approved.has("use")).toBe(true)
    expect(data.approved.has("uses")).toBe(true)
    expect(data.approved.has("used")).toBe(true)
    expect(data.approved.has("valve")).toBe(true)
    expect(data.approved.has("valves")).toBe(true)
    expect(data.nonApproved.get("utilize")?.useInstead[0]).toBe("USE (v)")
    expect(data.glossaryWords.has("breaker")).toBe(true)
    expect(data.glossaryWords.has("terminal")).toBe(true)
    expect(data.glossary.has("terminal block")).toBe(true)
  })

  test("missing files yield empty data without throwing", () => {
    const data = loadSteData({ dictionary: join(dir, "nope.json"), glossary: join(dir, "nope.txt") })
    expect(data.loaded).toBe(false)
    expect(data.approved.size).toBe(0)
    expect(data.nonApproved.size).toBe(0)
  })
})
