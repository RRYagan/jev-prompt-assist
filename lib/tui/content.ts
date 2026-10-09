/// <reference path="./bun-sqlite.d.ts" />
// Content index for prompt assist: full-text search over the shared idx index
// (code_search_fts) so a rough request ("update payment") can pull the files,
// functions and docs that actually talk about it.
//
// Deliberate design choices:
//  - It shares the idx SQLite file the lexicon already reads, read-only, and
//    only after `idx` has written a snapshot. The TUI calls it debounced.
//  - One FTS5 MATCH query per keyword, so hit attribution (which keyword pulled
//    this file) is exact. Measured ~9 ms cold / 0.5 ms warm per keyword on a
//    1265-file project.
//  - Script aware: unicode61 splits on punctuation for spaced scripts but treats
//    an unbroken CJK run as a single token, so packed runs also get a bounded
//    `LIKE` substring probe.
//  - Never throws: no index, no snapshot, missing FTS table or schema drift
//    yields [].
import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { extractKeywords, ftsTerm, likeTerm, splitByScript } from "./keywords"
import { idxDbPath, latestSnapshotId } from "./lexicon"

export interface ContentHit {
  /** Index path of the file that matched. */
  file: string
  /** Primary symbol (or path slug) the matched chunk belongs to. */
  symbol?: string
  /** Signature of the matched symbol, when enrichment is enabled. */
  signature?: string
  /** Leading doc comment / docstring of the matched symbol. */
  doc?: string
  /** FTS excerpt with match markers, for a preview line. */
  snippet?: string
  /** 1-based start line of the matched symbol. */
  line?: number
  /** idx language id of the file, when known ("python", "typescript", …). */
  language?: string
  /** Query keywords this hit matched. */
  keywords: string[]
  /** Higher is better: 1000 per distinct keyword, minus the bm25 rank. */
  score: number
  /** How many more exported symbols the file has beyond the one shown. */
  more?: number
}

export interface ContentOptions {
  /** Max hits to return (default 6). */
  limit?: number
  /** Enrich the top hits with language and symbol signatures (default true). */
  detail?: boolean
  /** Extra stopwords to drop from the query. */
  stop?: Iterable<string>
  /** Max keywords used for the index queries (default 5). */
  keywords?: number
}

interface Handle {
  db: Database
  snapshotId: string
}

interface RawHit {
  file: string
  symbol?: string
  snippet?: string
  rank: number
  /** Keyword whose query produced this row. */
  keyword: string
}

interface FtsRow {
  source_path: string | null
  file_path: string
  primary_symbol: string | null
  snip: string | null
  rank: number
}

/** Normalize to letters/digits only, so slugs and paths compare equal. */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-z\p{L}\p{N}]+/gu, "")
}

/**
 * idx stores the searchable form (not the clean path) in some columns:
 *   file_path      "tools/pay.py tools pay py"   (path + slug)
 *   primary_symbol "checkoutPayment checkout payment"  (name + slug)
 * `source_path` holds the clean path; the slug part is dropped when absent.
 */
function cleanFile(row: FtsRow): string {
  if (typeof row.source_path === "string" && row.source_path.trim()) return row.source_path.trim()
  const first = String(row.file_path ?? "").trim().split(/\s+/)[0]
  return first ?? ""
}

/** The symbol name, or undefined when idx could not attribute the chunk. */
function cleanSymbol(row: FtsRow, file: string): string | undefined {
  const raw = typeof row.primary_symbol === "string" ? row.primary_symbol.trim() : ""
  if (!raw) return undefined
  if (isSlugOf(raw, file)) return undefined
  const name = raw.split(/\s+/)[0]
  return name && !isSlugOf(name, file) ? name : undefined
}

/** True when a value is just the slug of the file path ("/" and "." → spaces). */
function isSlugOf(value: string, file: string): boolean {
  if (!value || !file) return false
  const withExt = normalizeKey(file)
  const noExt = normalizeKey(file.replace(/\.[^./\\]+$/, ""))
  const folded = normalizeKey(value)
  return folded === withExt || folded === noExt
}

let handle: { path: string; mtimeMs: number; at: number; open: Handle } | undefined
const HANDLE_TTL_MS = 60 * 1000

/** Open (or reuse) a read-only handle, picking the newest ready snapshot. */
function openHandle(worktree: string): Handle | undefined {
  const path = idxDbPath(worktree)
  try {
    if (!existsSync(path)) return undefined
    const mtimeMs = statSync(path).mtimeMs
    const now = Date.now()
    if (handle && handle.path === path && handle.mtimeMs === mtimeMs && now - handle.at < HANDLE_TTL_MS) {
      handle.at = now
      return handle.open
    }
    const db = new Database(path, { readonly: true })
    const snapshotId = latestSnapshotId(db)
    if (!snapshotId) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      return undefined
    }
    try {
      handle?.open.db.close()
    } catch {
      /* ignore */
    }
    handle = { path, mtimeMs, at: now, open: { db, snapshotId } }
    return handle.open
  } catch {
    return undefined
  }
}

/** True when the idx build of this worktree exposes the content FTS table. */
export function hasContentIndex(worktree: string | undefined): boolean {
  if (!worktree) return false
  const open = openHandle(worktree)
  if (!open) return false
  return tableExists(open, "code_search_fts")
}

function tableExists(open: Handle, name: string): boolean {
  try {
    const row = open.db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1")
      .get(name) as { ok?: number } | undefined
    return !!row
  } catch {
    return false
  }
}

const FTS_QUERY =
  "SELECT source_path, file_path, primary_symbol, snippet(code_search_fts, 6, '«', '»', ' … ', 9) AS snip, rank FROM code_search_fts WHERE code_search_fts MATCH ? AND project_id = 'default' AND snapshot_id = ? ORDER BY rank LIMIT ?"

const LIKE_QUERY =
  "SELECT source_path, file_path, primary_symbol, snippet(code_search_fts, 6, '«', '»', ' … ', 9) AS snip, rank FROM code_search_fts WHERE content LIKE ? ESCAPE '\\' AND project_id = 'default' AND snapshot_id = ? LIMIT ?"

/** Project an FTS row onto a hit, dropping idx's slug forms. */
function toHit(row: FtsRow, keyword: string): RawHit | undefined {
  const file = cleanFile(row)
  if (!file) return undefined
  return {
    file,
    symbol: cleanSymbol(row, file),
    snippet: typeof row.snip === "string" && row.snip ? row.snip : undefined,
    rank: typeof row.rank === "number" ? row.rank : 0,
    keyword,
  }
}

/**
 * Full-text search over the project index.
 *
 * Query keywords come from `extractKeywords`, so a draft in any language works:
 * spaced-script words hit the FTS index directly, CJK runs fall back to a
 * bounded `LIKE` probe.
 */
export function searchContent(
  worktree: string | undefined,
  text: string,
  opts: ContentOptions = {},
): ContentHit[] {
  const limit = Math.max(1, opts.limit ?? 6)
  const detail = opts.detail !== false
  const query = String(text ?? "").trim()
  if (!worktree || query.length < 2) return []

  const keywords = extractKeywords(query, { limit: opts.keywords ?? 5, stop: opts.stop })
  if (keywords.length === 0) return []

  const open = openHandle(worktree)
  if (!open || !tableExists(open, "code_search_fts")) return []

  const { spaced, packed } = splitByScript(keywords)
  const rows: RawHit[] = []
  try {
    for (const keyword of spaced) {
      const term = ftsTerm(keyword)
      if (!term) continue
      for (const row of open.db.query(FTS_QUERY).all(term, open.snapshotId, limit * 3) as FtsRow[]) {
        const hit = toHit(row, keyword)
        if (hit) rows.push(hit)
      }
    }
    for (const keyword of packed) {
      const term = likeTerm(keyword)
      if (!term) continue
      for (const row of open.db
        .query(LIKE_QUERY)
        .all(`%${term}%`, open.snapshotId, limit * 2) as FtsRow[]) {
        const hit = toHit(row, keyword)
        if (hit) rows.push(hit)
      }
    }
  } catch {
    // Schema drift or a locked index: keep whatever we already collected.
  }

  // Group by file: a file is good when several keywords point at it.
  type Group = { row: RawHit; keywords: Set<string>; rank: number }
  const byFile = new Map<string, Group>()
  for (const row of rows) {
    const existing = byFile.get(row.file)
    if (existing) {
      existing.keywords.add(row.keyword)
      existing.rank = Math.min(existing.rank, row.rank)
      continue
    }
    byFile.set(row.file, { row, keywords: new Set([row.keyword]), rank: row.rank })
  }

  const scored: ContentHit[] = []
  for (const [file, group] of byFile) {
    scored.push({
      file,
      symbol: group.row.symbol || undefined,
      snippet: group.row.snippet || undefined,
      keywords: [...group.keywords],
      score: group.keywords.size * 1000 - Math.abs(group.rank),
    })
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  const top = scored.slice(0, limit)
  return detail ? enrich(open, top) : top
}

interface SymbolRow {
  name: string
  file_path: string
  signature: string | null
  doc_comment: string | null
  exported: number | string | null
  container_name: string | null
  range_json: string | null
}

/** Attach language and, for the best hits, symbol signature/doc/line. */
function enrich(open: Handle, hits: ContentHit[]): ContentHit[] {
  const files = hits.map((hit) => hit.file)
  if (files.length === 0) return hits
  try {
    const marks = files.map(() => "?").join(", ")
    const symbols = open.db
      .query(
        `SELECT name, file_path, signature, doc_comment, exported, container_name, range_json FROM symbols WHERE project_id = 'default' AND snapshot_id = ? AND file_path IN (${marks}) ORDER BY file_path, rowid LIMIT 40`,
      )
      .all(open.snapshotId, ...files) as SymbolRow[]
    const langRows = open.db
      .query(
        `SELECT path, language_id FROM files WHERE project_id = 'default' AND snapshot_id = ? AND path IN (${marks})`,
      )
      .all(open.snapshotId, ...files) as Array<{ path: string; language_id: string | null }>
    const languageOf = new Map<string, string>()
    for (const row of langRows) {
      if (typeof row?.path === "string" && typeof row.language_id === "string" && row.language_id) {
        languageOf.set(row.path, row.language_id)
      }
    }
    const byFile = new Map<string, SymbolRow[]>()
    for (const row of symbols) {
      if (!row?.file_path) continue
      const list = byFile.get(row.file_path)
      if (list) list.push(row)
      else byFile.set(row.file_path, [row])
    }
    return hits.map((hit) => {
      const out: ContentHit = { ...hit, language: languageOf.get(hit.file) }
      const list = byFile.get(hit.file)
      if (!list || list.length === 0) return out
      const exported = list.filter(isExported)
      const pool = exported.length > 0 ? exported : list
      // One source of truth: the exact symbol the matched chunk pointed at,
      // else an exported symbol whose own name matched the query, else the
      // first exported symbol. Line and signature always come from that row.
      const exact = hit.symbol ? list.find((row) => row.name === hit.symbol) : undefined
      const pick = exact ?? bestSymbol(pool, hit.keywords) ?? pool[0]!
      out.symbol = pick.name
      out.signature = firstLine(pick.signature) ?? out.signature
      out.doc = firstLine(pick.doc_comment) ?? out.doc
      out.line = startLine(pick.range_json)
      if (exported.length > 1) out.more = exported.length - 1
      return out
    })
  } catch {
    return hits
  }
}

/** The symbol whose name carries one of the query keywords, if any. */
function bestSymbol(list: SymbolRow[], keywords: readonly string[]): SymbolRow | undefined {
  if (keywords.length === 0) return undefined
  const folded = keywords.map(normalizeKey)
  let fallback: SymbolRow | undefined
  for (const row of list) {
    const name = normalizeKey(row.name)
    if (folded.some((keyword) => name.includes(keyword))) return row
    if (!fallback && folded.some((keyword) => keyword.includes(name) && name.length >= 4)) {
      fallback = row
    }
  }
  return fallback
}

function isExported(row: SymbolRow): boolean {
  return row.exported === 1 || row.exported === "1"
}

function firstLine(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const line = value.split("\n")[0]?.trim()
  return line || undefined
}

function startLine(rangeJson: string | null | undefined): number | undefined {
  if (typeof rangeJson !== "string" || !rangeJson) return undefined
  try {
    const parsed = JSON.parse(rangeJson) as { start?: { line?: unknown } }
    return typeof parsed?.start?.line === "number" ? parsed.start.line + 1 : undefined
  } catch {
    return undefined
  }
}
