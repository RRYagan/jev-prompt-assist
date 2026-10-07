import { describe, expect, test } from "bun:test"
import {
  currentFragment,
  currentMention,
  suggest,
  symbolKindLabel,
  type Lexicon,
  type SuggestOptions,
} from "../lib/tui/suggest"

const lexicon: Lexicon = {
  symbols: [
    { name: "renderPanel", kind: 12, file: "src/panel.ts" },
    { name: "render", kind: 12, file: "src/render.ts" },
    { name: "renderAll", kind: 12, file: "src/render.ts" },
    { name: "deploy", kind: 12, file: "src/deploy.ts" },
    { name: "getProject", kind: 6, file: "src/api.ts" },
  ],
  paths: ["src/deploy.ts", "src/render.ts", "docs/deploy.md", "src/undeployed/thing.ts"],
}

function values(input: string, options?: SuggestOptions): string[] {
  return suggest(input, lexicon, options).map((item) => item.value)
}

describe("currentFragment", () => {
  test("returns the trailing identifier", () => {
    expect(currentFragment("fix the render")).toBe("render")
  })

  test("keeps path characters", () => {
    expect(currentFragment("edit src/deploy.ts")).toBe("src/deploy.ts")
  })

  test("empty when the draft ends in whitespace or is empty", () => {
    expect(currentFragment("fix it. ")).toBe("")
    expect(currentFragment("")).toBe("")
  })
})

describe("currentMention", () => {
  test("captures the trailing @token including the @", () => {
    expect(currentMention("look at @src/re")).toBe("@src/re")
    expect(currentMention("@")).toBe("@")
  })

  test("undefined when there is no mention", () => {
    expect(currentMention("just text")).toBeUndefined()
    expect(currentMention("email a@b ")).toBeUndefined()
  })
})

describe("suggest", () => {
  test("requires at least two characters", () => {
    expect(values("d")).toEqual([])
  })

  test("ranks symbol prefix matches by name length", () => {
    expect(values("ren").slice(0, 3)).toEqual(["render", "renderAll", "renderPanel"])
  })

  test("matches camelCase initialisms", () => {
    expect(values("gp")[0]).toBe("getProject")
  })

  test("matches subsequences", () => {
    expect(values("rpnl")[0]).toBe("renderPanel")
  })

  test("matches substrings below prefixes", () => {
    expect(values("ploy")).toContain("deploy")
  })

  test("tolerates a single typo", () => {
    expect(values("renrer")).toContain("render")
  })

  test("falls back to file paths and prefers prefix matches", () => {
    const out = suggest("deploy", lexicon)
    expect(out[0]!.value).toBe("deploy")
    expect(out.map((item) => item.value)).toContain("deploy.ts")
    expect(out.map((item) => item.value)).toContain("deploy.md")
    expect(out.find((item) => item.value === "deploy.ts")!.detail).toBe("src")
  })

  test("a path-like fragment yields full paths", () => {
    expect(values("src/re")).toEqual(["src/render.ts"])
  })

  test("mention mode returns @paths", () => {
    const out = suggest("src/re", lexicon, { mention: true })
    expect(out[0]).toMatchObject({ value: "@src/render.ts", kind: "mention" })
  })

  test("honours hot files within a tier", () => {
    const hot = new Set(["src/panel.ts"])
    expect(values("ren", { hotFiles: hot })[0]).toBe("renderPanel")
  })

  test("respects the limit and dedupes", () => {
    expect(values("ren", { limit: 2 })).toEqual(["render", "renderAll"])
    expect(values("render", { limit: 10 })).toEqual([
      "render",
      "renderAll",
      "renderPanel",
      "render.ts",
    ])
  })

  test("returns nothing when there is no match", () => {
    expect(values("zzzz")).toEqual([])
  })
})

describe("symbolKindLabel", () => {
  test("maps LSP kinds and passes through strings", () => {
    expect(symbolKindLabel(12)).toBe("function")
    expect(symbolKindLabel(5)).toBe("class")
    expect(symbolKindLabel("method")).toBe("method")
    expect(symbolKindLabel(undefined)).toBe("")
  })
})
