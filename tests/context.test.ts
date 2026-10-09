import { describe, expect, test } from "bun:test"
import type { ContentHit } from "../lib/tui/content"
import { contextSuggestions, draftPrompt } from "../lib/tui/context"
import { currentFragment, currentMention } from "../lib/tui/suggest"

function hit(file: string, extra: Partial<ContentHit> = {}): ContentHit {
  return { file, keywords: ["payment"], score: 2000, ...extra }
}

const HITS: ContentHit[] = [
  hit("src/sales/payment_providers.ts", {
    symbol: "refundPayment",
    line: 42,
    language: "typescript",
    keywords: ["payment", "momo"],
  }),
  hit("src/sales/checkout.ts", { symbol: "checkout", line: 12, language: "typescript" }),
  hit("docs/payments.md", { language: "document" }),
]

describe("contextSuggestions", () => {
  test("offers a rewrite plus one append-only target per hit", () => {
    const items = contextSuggestions("update payment for momo", HITS)
    expect(items).toHaveLength(4)
    const sharpen = items[0]!
    expect(sharpen.kind).toBe("context")
    expect(sharpen.replaceAll).toBe(true)
    expect(sharpen.value).toContain("update payment for momo")
    expect(sharpen.value).toContain("Target: src/sales/payment_providers.ts")
    expect(sharpen.value).toContain("refundPayment (payment_providers.ts:42)")
  })

  test("target entries append rather than replace the draft", () => {
    const items = contextSuggestions("update payment", HITS)
    const targets = items.filter((item) => item.append)
    expect(targets).toHaveLength(3)
    expect(targets[0]!.value).toBe("src/sales/payment_providers.ts")
    expect(targets[0]!.label).toBe("refundPayment")
    expect(targets[0]!.detail).toContain("L42")
    expect(targets[0]!.detail).toContain("typescript")
    expect(targets[0]!.detail).toContain("matched: payment momo")
  })

  test("mentions the file when asked", () => {
    const items = contextSuggestions("update payment", HITS, { mention: true })
    expect(items[1]!.value).toBe("@src/sales/payment_providers.ts")
  })

  test("honours the limit", () => {
    expect(contextSuggestions("update payment", HITS, { limit: 1 })).toHaveLength(2)
  })

  test("returns nothing without hits", () => {
    expect(contextSuggestions("update payment", [])).toEqual([])
    expect(contextSuggestions("update payment", undefined)).toEqual([])
  })

  test("uses the file name when the hit has no symbol", () => {
    const items = contextSuggestions("update payment", [hit("docs/payments.md")])
    expect(items[1]!.label).toBe("payments.md")
  })
})

describe("draftPrompt", () => {
  test("keeps the user wording and appends the targets", () => {
    expect(draftPrompt("update payment", HITS)).toBe(
      [
        "update payment",
        "Target: src/sales/payment_providers.ts, src/sales/checkout.ts, docs/payments.md",
        "Symbols: refundPayment (payment_providers.ts:42), checkout (checkout.ts:12)",
      ].join("\n"),
    )
  })

  test("works for any language", () => {
    expect(draftPrompt("改善支払い処理", HITS)).toContain("改善支払い処理\nTarget: ")
  })

  test("returns the trimmed draft when there are no hits", () => {
    expect(draftPrompt("  update payment  ", [])).toBe("update payment")
  })
})

describe("currentFragment / currentMention", () => {
  test("still matches ASCII fragments", () => {
    expect(currentFragment("fix the render")).toBe("render")
    expect(currentFragment("edit src/deploy.ts")).toBe("src/deploy.ts")
    expect(currentFragment("fix it. ")).toBe("")
  })

  test("matches non-latin identifiers and words", () => {
    expect(currentFragment("改善支払い処理")).toBe("改善支払い処理")
    expect(currentFragment("Исправить платежей")).toBe("платежей")
    expect(currentFragment("결제 모듈을 수정해")).toBe("수정해")
    expect(currentMention("@src/sales/支払い.ts")).toBe("@src/sales/支払い.ts")
  })
})

describe("contextSuggestions after a rewrite was accepted", () => {
  const hits = [
    { file: "src/pay.ts", symbol: "checkout", line: 12, keywords: ["pay"], score: 5000 },
    { file: "src/refund.ts", symbol: "refund", line: 30, keywords: ["pay"], score: 4000 },
  ]

  test("drops the sharpen entry once the draft carries a Target block", () => {
    const pinned = contextSuggestions("update payment\nTarget: src/pay.ts", hits)
    expect(pinned.some((item) => item.replaceAll)).toBe(false)
    expect(pinned.every((item) => item.append)).toBe(true)
  })

  test("keeps offering append targets after a rewrite", () => {
    const pinned = contextSuggestions("update payment\nTarget: src/pay.ts", hits)
    expect(pinned.map((item) => item.value)).toEqual(["src/pay.ts", "src/refund.ts"])
  })

  test("still offers sharpen when Target: only appears mid-sentence", () => {
    const draft = "write a story about Target: mars, then tests"
    const out = contextSuggestions(draft, hits)
    expect(out.some((item) => item.replaceAll)).toBe(true)
  })
})
