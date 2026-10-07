import { describe, expect, test } from "bun:test"
import { currentFragment, suggestFor, type Lexicon } from "../lib/tui/suggest"

const lexicon: Lexicon = {
  symbols: [
    { name: "renderPanel", kind: 12, file: "src/panel.ts" },
    { name: "render", kind: 12, file: "src/render.ts" },
    { name: "renderAll", kind: 12, file: "src/render.ts" },
    { name: "deploy", kind: 12, file: "src/deploy.ts" },
  ],
  paths: ["src/deploy.ts", "src/render.ts", "docs/deploy.md", "src/undeployed/thing.ts"],
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

describe("suggestFor", () => {
  test("requires at least two characters", () => {
    expect(suggestFor("d", lexicon)).toEqual([])
  })

  test("ranks symbol prefix matches by name length", () => {
    expect(suggestFor("ren", lexicon).slice(0, 3)).toEqual(["render", "renderAll", "renderPanel"])
  })

  test("falls back to file paths and prefers prefix matches", () => {
    const out = suggestFor("deploy", lexicon)
    expect(out[0]).toBe("deploy")
    expect(out).toContain("deploy.ts")
    expect(out).toContain("deploy.md")
  })

  test("a path-like fragment yields full paths", () => {
    expect(suggestFor("src/re", lexicon)).toEqual(["src/render.ts"])
  })

  test("respects the limit and dedupes", () => {
    expect(suggestFor("ren", lexicon, 2)).toEqual(["render", "renderAll"])
    expect(suggestFor("render", lexicon, 10)).toEqual(["render", "renderAll", "renderPanel", "render.ts"])
  })

  test("returns nothing when there is no match", () => {
    expect(suggestFor("zzzz", lexicon)).toEqual([])
  })
})
