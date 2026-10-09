/// <reference path="./bun-sqlite.d.ts" />
// Project lexicon for prompt autosuggest: reads the per-project idx index
// (<worktree>/.indexer-cli/db.sqlite) directly with the built-in bun:sqlite,
// read-only. This is deliberately a direct SQLite read: shelling out to `idx`
// costs 10-54s and takes a lock, so it must never be on the keystroke path.
//
// Never throws: any failure (no index, no snapshot, corrupt/missing sidecar,
// schema drift) yields undefined so the panel degrades to heuristics only.
import { Database } from "bun:sqlite"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Lexicon, LexiconEntry } from "./suggest"

const MAX_SYMBOLS = 80000
const MAX_PATHS = 80000
const MAX_FILES = 80000
const TTL_MS = 5 * 60 * 1000

let cache: { path: string; mtimeMs: number; at: number; lexicon: Lexicon } | undefined

export function idxDbPath(worktree: string): string {
  return join(worktree, ".indexer-cli", "db.sqlite")
}

export function loadLexicon(worktree: string | undefined): Lexicon | undefined {
  if (!worktree) return undefined
  const dbPath = idxDbPath(worktree)
  try {
    if (!existsSync(dbPath)) return undefined
    const mtimeMs = statSync(dbPath).mtimeMs
    const now = Date.now()
    if (cache && cache.path === dbPath && cache.mtimeMs === mtimeMs && now - cache.at < TTL_MS) {
      return cache.lexicon
    }
    const lexicon = readLexicon(dbPath)
    if (!lexicon) return undefined
    cache = { path: dbPath, mtimeMs, at: now, lexicon }
    return lexicon
  } catch {
    return undefined
  }
}

function readLexicon(dbPath: string): Lexicon | undefined {
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const snapshotId = latestSnapshotId(db)
    if (!snapshotId) return undefined

    // idx schemas drift (v1 had LSP numeric kinds, v2 text kinds + docs). Read
    // only the columns that exist, so an older index still yields a lexicon.
    const symbolCols = columnsOf(db, "symbols")
    const fileCols = columnsOf(db, "files")
    if (!symbolCols.has("name") || !fileCols.has("path")) return undefined

    const symbolRows = db
      .query(
        `SELECT ${pickColumns(symbolCols, [
          "name",
          "kind",
          "file_path",
          "signature",
          "doc_comment",
          "container_name",
          "exported",
          "range_json",
        ])} FROM symbols WHERE project_id = 'default' AND snapshot_id = ? LIMIT ?`,
      )
      .all(snapshotId, MAX_SYMBOLS) as Array<{
      name: string
      kind: number | string | null
      file_path: string
      signature: string | null
      doc_comment: string | null
      container_name: string | null
      exported: number | string | null
      range_json: string | null
    }>
    const pathRows = db
      .query(`SELECT ${pickColumns(fileCols, ["path"])} FROM files WHERE project_id = 'default' AND snapshot_id = ? LIMIT ?`)
      .all(snapshotId, MAX_PATHS) as Array<{ path: string }>
    const langRows = fileCols.has("language_id")
      ? (db
          .query(
            `SELECT path, language_id FROM files WHERE project_id = 'default' AND snapshot_id = ? LIMIT ?`,
          )
          .all(snapshotId, MAX_FILES) as Array<{ path: string; language_id: string | null }>)
      : []

    const symbols: LexiconEntry[] = []
    for (const row of symbolRows) {
      if (!row?.name) continue
      // idx v1 stored LSP numeric kinds; idx v2 stores text kinds
      // ("function", "class", …). Pass both through — symbolKindLabel renders
      // either.
      const kind = typeof row.kind === "number" ? row.kind : typeof row.kind === "string" ? row.kind : ""
      symbols.push({
        name: row.name,
        kind,
        file: row.file_path ?? "",
        signature: row.signature ?? undefined,
        doc: row.doc_comment ?? undefined,
        container: row.container_name ?? undefined,
        exported: row.exported === 1 || row.exported === "1" || row.exported === true,
        line: startLine(row.range_json),
      })
    }
    const paths = pathRows
      .map((row) => row.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0)

    const languageOf: Record<string, string> = {}
    for (const row of langRows) {
      if (typeof row?.path === "string" && typeof row.language_id === "string" && row.language_id) {
        languageOf[row.path] = row.language_id
      }
    }
    const languages = [...new Set(Object.values(languageOf))].sort()

    const lexicon: Lexicon = { symbols, paths }
    if (languages.length > 0) lexicon.languages = languages
    if (Object.keys(languageOf).length > 0) lexicon.languageOf = languageOf
    return lexicon
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/** Newest completed snapshot for the default project, or undefined. */
export function latestSnapshotId(db: Database): string | undefined {
  try {
    const snapshot = db
      .query(
        "SELECT id FROM snapshots WHERE project_id = 'default' AND status IN ('completed', 'ready') ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { id?: string } | undefined
    return typeof snapshot?.id === "string" ? snapshot.id : undefined
  } catch {
    return undefined
  }
}

/** Column names of a table, or an empty set when the table is missing. */
function columnsOf(db: Database, table: string): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    return new Set(rows.map((row) => row?.name).filter((name): name is string => !!name))
  } catch {
    return new Set()
  }
}

/** Keep only the wanted columns that exist, as a SELECT projection. */
function pickColumns(have: ReadonlySet<string>, wanted: string[]): string {
  const kept = wanted.filter((column) => have.has(column))
  return kept.length > 0 ? kept.join(", ") : "*"
}

/** Pull the 1-based start line out of an idx `range_json` payload. */
function startLine(rangeJson: string | null): number | undefined {
  if (typeof rangeJson !== "string" || !rangeJson) return undefined
  try {
    const parsed = JSON.parse(rangeJson) as unknown
    const line = (parsed as { start?: { line?: unknown } })?.start?.line
    return typeof line === "number" ? line + 1 : undefined
  } catch {
    return undefined
  }
}
