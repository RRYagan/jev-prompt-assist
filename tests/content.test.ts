import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasContentIndex, searchContent } from "../lib/tui/content"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Row {
  source: string
  content: string
  symbol: string
  signature?: string
  language: string
  line?: number
}

const ROWS: Row[] = [
  {
    source: "src/sales/payment_providers.ts",
    content: "export async function refundPayment(reference: string, amount: number) { ... }",
    symbol: "refundPayment",
    signature: "export async function refundPayment(reference: string, amount: number)",
    language: "typescript",
    line: 42,
  },
  {
    source: "src/sales/checkout.ts",
    content: "export function checkout(cart: Cart) { const momo = payment.momo ?? null }",
    symbol: "checkout",
    signature: "export function checkout(cart: Cart)",
    language: "typescript",
    line: 12,
  },
  {
    // Japanese: no spaces, so this is one FTS token and needs the LIKE probe.
    source: "src/sales/支払い.ts",
    content: "export function processPayment() { return 改善支払い処理(payment) }",
    symbol: "processPayment",
    signature: "export function processPayment()",
    language: "typescript",
    line: 7,
  },
  {
    // Korean is space separated, so the FTS tokenizer handles it directly.
    source: "src/sales/결제.ts",
    content: "export function handlePayment() { const 결제 = 모듈(payment) }",
    symbol: "handlePayment",
    signature: "export function handlePayment()",
    language: "typescript",
    line: 3,
  },
  {
    source: "src/sales/plateg.ts",
    content: "export function correctSpelling() { return платежей ?? 'payment' }",
    symbol: "correctSpelling",
    signature: "export function correctSpelling()",
    language: "typescript",
    line: 5,
  },
  {
    source: "docs/payments.md",
    content: "# Payments\n\nThe payment pipeline calls checkout and then refundPayment.",
    symbol: " Payments",
    language: "document",
  },
]

/**
 * Build an idx-shaped index: the FTS table mirrors the real one (slugged
 * file_path/primary_symbol with a clean source_path), because that is what the
 * content reader has to survive.
 */
function makeIndex(withFts = true): string {
  const root = mkdtempSync(join(tmpdir(), "jev-ctx-"))
  roots.push(root)
  const dir = join(root, ".indexer-cli")
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, "db.sqlite"))
  db.run("CREATE TABLE snapshots (id TEXT, project_id TEXT, status TEXT, created_at INTEGER)")
  db.run(
    "CREATE TABLE files (project_id TEXT, snapshot_id TEXT, path TEXT, language_id TEXT, file_domain TEXT)",
  )
  db.run(
    "CREATE TABLE symbols (project_id TEXT, snapshot_id TEXT, id TEXT, file_path TEXT, kind TEXT, name TEXT, container_name TEXT, exported INTEGER, range_json TEXT, signature TEXT, doc_comment TEXT)",
  )
  db.run("INSERT INTO snapshots VALUES ('s1', 'default', 'ready', 100)")

  const insertFile = db.prepare(
    "INSERT INTO files VALUES ('default', 's1', ?, ?, ?)",
  )
  for (const row of ROWS) {
    insertFile.run(row.source, row.language, row.language === "document" ? "document" : "code")
  }

  const insertSymbol = db.prepare(
    "INSERT INTO symbols (project_id, snapshot_id, id, file_path, kind, name, container_name, exported, range_json, signature, doc_comment) VALUES ('default', 's1', ?, ?, 'function', ?, NULL, 1, ?, ?, ?)",
  )
  let id = 0
  for (const row of ROWS) {
    if (!row.signature) continue
    id += 1
    insertSymbol.run(
      `sym-${id}`,
      row.source,
      row.symbol.trim(),
      JSON.stringify({ start: { line: (row.line ?? 1) - 1 }, end: { line: row.line ?? 1 } }),
      row.signature,
      "Does a payment thing.",
    )
  }

  if (withFts) {
    db.run(
      "CREATE VIRTUAL TABLE code_search_fts USING fts5(project_id UNINDEXED, snapshot_id UNINDEXED, chunk_id UNINDEXED, source_path UNINDEXED, file_path, primary_symbol, content, tokenize='unicode61 remove_diacritics 2')",
    )
    const insertFts = db.prepare(
      "INSERT INTO code_search_fts (project_id, snapshot_id, chunk_id, source_path, file_path, primary_symbol, content) VALUES ('default', 's1', ?, ?, ?, ?, ?)",
    )
    id = 0
    for (const row of ROWS) {
      id += 1
      insertFts.run(
        `c-${id}`,
        row.source,
        // The real index stores the searchable form, not the clean path.
        `${row.source} ${row.source.replace(/[/._]/g, " ")}`,
        `${row.symbol.trim()} ${row.symbol.trim().replace(/(?=[A-Z])/g, " ").toLowerCase()}`,
        row.content,
      )
    }
  }
  db.close()
  return root
}

describe("searchContent", () => {
  test("reports whether the content index exists", () => {
    expect(hasContentIndex(makeIndex())).toBe(true)
    expect(hasContentIndex(makeIndex(false))).toBe(false)
    expect(hasContentIndex(undefined)).toBe(false)
    const empty = mkdtempSync(join(tmpdir(), "jev-ctx-"))
    roots.push(empty)
    expect(hasContentIndex(empty)).toBe(false)
  })

  test("finds the files and functions a rough request talks about", () => {
    const hits = searchContent(makeIndex(), "update payment for momo")
    expect(hits.length).toBeGreaterThan(0)
    const files = hits.map((hit) => hit.file)
    expect(files).toContain("src/sales/checkout.ts")
    expect(files).toContain("src/sales/payment_providers.ts")
    // Docs are indexed too.
    expect(files).toContain("docs/payments.md")
    const checkout = hits.find((hit) => hit.file === "src/sales/checkout.ts")
    expect(checkout?.keywords).toContain("momo")
    expect(checkout?.language).toBe("typescript")
  })

  test("enriches hits with a signature and a line number", () => {
    const hits = searchContent(makeIndex(), "fix refundPayment rounding")
    const provider = hits.find((hit) => hit.file === "src/sales/payment_providers.ts")
    expect(provider).toBeDefined()
    expect(provider?.symbol).toBe("refundPayment")
    expect(provider?.line).toBe(42)
    expect(provider?.signature).toContain("refundPayment")
    expect(provider?.language).toBe("typescript")
    expect(provider?.doc).toBe("Does a payment thing.")
  })

  test("ranks a file matched by more keywords first", () => {
    const hits = searchContent(makeIndex(), "payment momo")
    // Both keywords hit checkout.ts, so it must outrank a single-keyword match.
    expect(hits[0]?.file).toBe("src/sales/checkout.ts")
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  test("matches CJK runs through the substring probe", () => {
    const hits = searchContent(makeIndex(), "改善支払い処理")
    expect(hits.map((hit) => hit.file)).toContain("src/sales/支払い.ts")
  })

  test("matches space-separated scripts through the FTS index", () => {
    expect(searchContent(makeIndex(), "결제 모듈을 수정해 주세요").map((h) => h.file)).toContain(
      "src/sales/결제.ts",
    )
    expect(searchContent(makeIndex(), "Исправить платежей").map((h) => h.file)).toContain(
      "src/sales/plateg.ts",
    )
  })

  test("ignores the slug columns the real index writes", () => {
    const hits = searchContent(makeIndex(), "checkout")
    const checkout = hits.find((hit) => hit.file === "src/sales/checkout.ts")
    expect(checkout?.symbol).toBe("checkout")
    expect(checkout?.file).not.toContain(" ")
  })

  test("skips enrichment when detail is off", () => {
    const hit = searchContent(makeIndex(), "checkout", { detail: false }).find(
      (candidate) => candidate.file === "src/sales/checkout.ts",
    )
    expect(hit?.file).toBe("src/sales/checkout.ts")
    expect(hit?.signature).toBeUndefined()
    expect(hit?.language).toBeUndefined()
  })

  test("returns nothing without an index, snapshot or draft", () => {
    const empty = mkdtempSync(join(tmpdir(), "jev-ctx-"))
    roots.push(empty)
    expect(searchContent(empty, "update payment")).toEqual([])
    expect(searchContent(undefined, "update payment")).toEqual([])
    expect(searchContent(makeIndex(), "  ")).toEqual([])
    expect(searchContent(makeIndex(), "the a of and")).toEqual([])
  })

  test("honours the limit", () => {
    const hits = searchContent(makeIndex(), "payment", { limit: 2 })
    expect(hits.length).toBe(2)
  })
})
