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
    const snapshot = db
      .query(
        "SELECT id FROM snapshots WHERE project_id = 'default' AND status IN ('completed', 'ready') ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { id?: string } | undefined
    const snapshotId = snapshot?.id
    if (!snapshotId) return undefined

    const symbolRows = db
      .query(
        "SELECT name, kind, file_path, signature FROM symbols WHERE project_id = 'default' AND snapshot_id = ? LIMIT ?",
      )
      .all(snapshotId, MAX_SYMBOLS) as Array<{
      name: string
      kind: number
      file_path: string
      signature: string | null
    }>
    const pathRows = db
      .query("SELECT path FROM files WHERE project_id = 'default' AND snapshot_id = ? LIMIT ?")
      .all(snapshotId, MAX_PATHS) as Array<{ path: string }>

    const symbols: LexiconEntry[] = []
    for (const row of symbolRows) {
      if (!row?.name) continue
      symbols.push({
        name: row.name,
        kind: typeof row.kind === "number" ? row.kind : 0,
        file: row.file_path ?? "",
        signature: row.signature ?? undefined,
      })
    }
    const paths = pathRows
      .map((row) => row.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0)

    return { symbols, paths }
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
