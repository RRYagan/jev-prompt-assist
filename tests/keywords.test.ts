import { describe, expect, test } from "bun:test"
import { extractKeywords, ftsTerm, likeTerm, splitByScript } from "../lib/tui/keywords"

describe("extractKeywords", () => {
  test("drops generic action words and keeps the topic", () => {
    expect(extractKeywords("update payment for momo")).toEqual(["payment", "momo"])
  })

  test("splits camelCase, snake_case and kebab-case", () => {
    // The whole underscore form rides along for phrase matching; the parts
    // give recall.
    expect(extractKeywords("REFUND_amount_cents for momo")).toEqual([
      "refund",
      "amount",
      "cents",
      "refund_amount_cents",
      "momo",
    ])
    expect(extractKeywords("fix checkoutPayment and checkout-payment")).toEqual([
      "checkoutpayment",
      "checkout",
      "payment",
    ])
  })

  test("keeps the whole underscore form for phrase matching", () => {
    const words = extractKeywords("fix the refund_amount_cents rounding")
    expect(words).toContain("refund_amount_cents")
    expect(words).toContain("refund")
  })

  test("splits paths and drops extensions", () => {
    const words = extractKeywords("fix src/deploy.ts")
    expect(words).toContain("deploy")
    expect(words).not.toContain("src/deploy.ts")
    expect(words.some((word) => word === "ts")).toBe(false)
  })

  test("ranks earlier words first", () => {
    expect(extractKeywords("payment checkout momo payment").indexOf("payment")).toBe(0)
  })

  test("folds accents the way unicode61 remove_diacritics does", () => {
    // "café" -> "cafe"; the FTS index tokenizes the same way.
    expect(extractKeywords("arreglar la cocina de café")).toContain("cafe")
  })

  test("leaves scripts that NFKD would corrupt alone", () => {
    // Cyrillic: NFKD must not split the word into base letters.
    expect(extractKeywords("Исправить платежей")).toEqual(["исправить", "платежей"])
    // Korean is space separated, so words survive verbatim (precomposed).
    expect(extractKeywords("결제 모듈을 수정해 주세요")).toEqual(["결제", "모듈을", "수정해", "주세요"])
  })

  test("expands a CJK run into bigrams", () => {
    const words = extractKeywords("改善支払い処理")
    expect(words).toEqual(["改善", "善支", "支払", "払い", "い処"])
    expect(words[0]!.length).toBe(2)
  })

  test("caps the result count", () => {
    expect(extractKeywords("alpha bravo charlie delta echo foxtrot golf", { limit: 3 })).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ])
  })

  test("honours extra stopwords", () => {
    expect(extractKeywords("payment momo", { stop: ["momo"] })).toEqual(["payment"])
  })

  test("ignores empty and punctuation-only text", () => {
    expect(extractKeywords("")).toEqual([])
    expect(extractKeywords("   ... --- !!! ")).toEqual([])
  })

  test("keeps a single non-generic word", () => {
    expect(extractKeywords("payment")).toEqual(["payment"])
  })
})

describe("splitByScript", () => {
  test("separates spaced scripts from packed CJK runs", () => {
    const { spaced, packed } = splitByScript(extractKeywords("改善支払い処理 payment"))
    expect(spaced).toEqual(["payment"])
    expect(packed).toEqual(["改善", "善支", "支払", "払い", "い処"])
  })

  test("treats korean as a spaced script", () => {
    const { spaced, packed } = splitByScript(extractKeywords("결제 모듈"))
    expect(spaced).toEqual(["결제", "모듈"])
    expect(packed).toEqual([])
  })
})

describe("ftsTerm / likeTerm", () => {
  test("quotes FTS terms and drops query syntax", () => {
    expect(ftsTerm("payment")).toBe('"payment"')
    expect(ftsTerm('pay"ment OR *')).toBe('"paymentOR"')
    expect(ftsTerm("")).toBe("")
  })

  test("escapes LIKE metacharacters", () => {
    expect(likeTerm("100%")).toBe("100\\%")
    expect(likeTerm("a_b\\c")).toBe("a\\_b\\\\c")
    expect(likeTerm("支払")).toBe("支払")
  })
})

describe("extractKeywords with foreign function words", () => {
  test("drops Spanish/Portuguese filler", () => {
    expect(extractKeywords("arreglar el reembolso de pagos con café refund", { limit: 5 })).toEqual([
      "arreglar",
      "reembolso",
      "pagos",
      "cafe",
      "refund",
    ])
  })

  test("drops French filler", () => {
    expect(extractKeywords("corriger le remboursement des paiements", { limit: 5 })).toEqual([
      "corriger",
      "remboursement",
      "paiements",
    ])
  })

  test("drops German filler and folds the umlaut like the FTS tokenizer", () => {
    expect(extractKeywords("die Rückzahlung der Zahlungen reparieren", { limit: 5 })).toEqual([
      "ruckzahlung",
      "zahlungen",
      "reparieren",
    ])
  })

  test("keeps short identifiers that collide with function words", () => {
    // `il` (intermediate language) is a common abbreviation; `de`/`le` are not.
    expect(extractKeywords("lower the il before de queue", { limit: 6 })).toContain("il")
  })
})
