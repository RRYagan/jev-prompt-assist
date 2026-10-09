import { describe, expect, test } from "bun:test"
import { allowsEnglishLint, scriptOf } from "../lib/tui/script"
import { heuristicAnalysis } from "../lib/tui/analyze"

describe("scriptOf", () => {
  test("classifies the dominant script", () => {
    expect(scriptOf("fix the payment flow")).toBe("latin")
    expect(scriptOf("改善支払い処理")).toBe("cjk")
    expect(scriptOf("결제 모듈을 수정해 주세요")).toBe("hangul")
    expect(scriptOf("Исправить платежей")).toBe("other")
    expect(scriptOf("")).toBe("unknown")
    expect(scriptOf("123 ... !!!")).toBe("unknown")
  })

  test("ignores punctuation and digits", () => {
    expect(scriptOf("src/支払い.ts (開発中) — テスト 2024")).toBe("cjk")
  })
})

describe("allowsEnglishLint", () => {
  test("gates the english-only tiers by script", () => {
    expect(allowsEnglishLint("fix the payment flow")).toBe(true)
    // Grammar/STE rules are English; running them here is pure noise.
    expect(allowsEnglishLint("改善支払い処理")).toBe(false)
    expect(allowsEnglishLint("결제 모듈을 수정해 주세요")).toBe(false)
    expect(allowsEnglishLint("Исправить платежей")).toBe(false)
    // No letters: nothing to lint, nothing to break.
    expect(allowsEnglishLint("")).toBe(true)
  })
})

describe("heuristicAnalysis in other languages", () => {
  test("counts a unicode target as a concrete one", () => {
    // The old SPECIFIC regex was ASCII-only, so every non-latin draft scored
    // as if it named no files, symbols or values.
    const japanese = heuristicAnalysis("src/sales/支払い.ts の processPayment を直して")
    expect(japanese.segments.some((segment) => segment.score > 0.5)).toBe(true)
    expect(japanese.tips).not.toContain("Name the exact files/symbols/values involved.")
  })

  test("still counts a unicode path with digits and parens", () => {
    const analysis = heuristicAnalysis("改善支払い処理 in 결제/модуль.ts:12 processPayment()")
    expect(analysis.score).toBeGreaterThan(0.4)
  })
})
