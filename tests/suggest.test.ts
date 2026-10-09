import { describe, expect, test } from "bun:test"
import {
  applySuggestion,
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

describe("suggest with a multilingual lexicon", () => {
  const multi: Lexicon = {
    symbols: [
      { name: "支払い処理", kind: "function", file: "src/支払い.ts" },
      { name: "결제처리", kind: "function", file: "src/결제.ts" },
      { name: "исправитьПлатёж", kind: "function", file: "src/платёж.ts" },
      { name: "traiterPaiement", kind: "function", file: "src/paiement.ts" },
    ],
    paths: ["src/支払い.ts", "src/결제.ts", "src/платёж.ts", "src/paiement.ts"],
    languages: ["typescript"],
    languageOf: { "src/支払い.ts": "typescript" },
  }

  test("matches a CJK symbol by prefix", () => {
    const values2 = suggest("支払い", multi).map((item) => item.value)
    expect(values2).toContain("支払い処理")
    // Paths fill the remaining slots.
    expect(values2).toContain("支払い.ts")
  })

  test("matches Hangul and Cyrillic symbols", () => {
    expect(suggest("결제", multi).map((item) => item.value)).toContain("결제처리")
    expect(suggest("исправить", multi).map((item) => item.value)).toContain("исправитьПлатёж")
  })

  test("folds accents when matching", () => {
    expect(suggest("traiterpaiement", multi).map((item) => item.value)).toEqual([
      "traiterPaiement",
    ])
  })

  test("completes a mention for a non-latin path", () => {
    const items = suggest("支払い", multi, { mention: true })
    expect(items[0]!.value).toBe("@src/支払い.ts")
  })

  test("carries idx text kinds through to the detail line", () => {
    // idx v2 stores 'function'/'class'/… — a numeric coercion used to blank it.
    expect(suggest("支払い", multi)[0]!.detail).toContain("function")
  })
})

describe("applySuggestion", () => {
  const input = "update payment for momo"

  test("replaces the trailing fragment", () => {
    expect(applySuggestion(input, "momo", { value: "momoRefunds", label: "", kind: "symbol" })).toBe(
      "update payment for momoRefunds",
    )
  })

  test("ignores a fragment that no longer trails the draft", () => {
    expect(applySuggestion(input, "payment", { value: "x", label: "", kind: "symbol" })).toBeUndefined()
  })

  test("splices a style replacement into its span", () => {
    const draft = "receive the payment"
    const found = { value: "receive", label: "", kind: "style", span: { start: 0, end: 7 } }
    expect(applySuggestion(draft, "", found)).toBe("receive the payment")
    // A span outside the draft is not actionable.
    expect(applySuggestion("hi", "", { ...found, span: { start: 0, end: 9 } })).toBeUndefined()
  })

  test("skips an advisory finding with no replacement", () => {
    const advisory = { value: "", label: "avoid 'utilize'", detail: "STE 4.3", kind: "style" as const }
    expect(applySuggestion(input, "", advisory)).toBeUndefined()
  })

  test("rewrites the whole draft for a sharpen suggestion", () => {
    const sharpened = `update payment for momo\nTarget: payment.py\nSymbols: checkout_payment (payment.py:230)`
    expect(applySuggestion(input, "momo", { value: sharpened, label: "sharpen", kind: "context", replaceAll: true })).toBe(
      sharpened,
    )
  })

  test("appends a target with a single space glue", () => {
    expect(
      applySuggestion(input, "momo", { value: "@payment.py", label: "checkout_payment", kind: "context", append: true }),
    ).toBe("update payment for momo @payment.py")
  })

  test("never doubles the glue around an appended target", () => {
    expect(
      applySuggestion("update payment for momo ", "", { value: "@payment.py", label: "", kind: "context", append: true }),
    ).toBe("update payment for momo @payment.py")
    expect(
      applySuggestion("", "", { value: "@payment.py", label: "", kind: "context", append: true }),
    ).toBe("@payment.py")
  })

  test("keeps an empty rewrite or append inert", () => {
    expect(applySuggestion(input, "", { value: "", label: "", kind: "context", replaceAll: true })).toBeUndefined()
    expect(applySuggestion(input, "", { value: "", label: "", kind: "context", append: true })).toBeUndefined()
  })
})
