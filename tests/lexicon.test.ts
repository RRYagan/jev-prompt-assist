import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadLexicon } from "../lib/tui/lexicon"

const roots: string[] = []

function makeIndex(status: string): string {
  const root = mkdtempSync(join(tmpdir(), "jev-lex-"))
  roots.push(root)
  const dir = join(root, ".indexer-cli")
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, "db.sqlite"))
  db.run("CREATE TABLE snapshots (id TEXT, project_id TEXT, status TEXT, created_at INTEGER)")
  db.run("CREATE TABLE symbols (name TEXT, kind INTEGER, file_path TEXT, signature TEXT, project_id TEXT, snapshot_id TEXT)")
  db.run("CREATE TABLE files (path TEXT, project_id TEXT, snapshot_id TEXT)")
  db.run("INSERT INTO snapshots VALUES ('s1', 'default', ?, 100)", status)
  db.run("INSERT INTO symbols VALUES ('renderPanel', 12, 'src/panel.ts', 'fn', 'default', 's1')")
  db.run("INSERT INTO files VALUES ('src/panel.ts', 'default', 's1')")
  db.close()
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("loadLexicon", () => {
  test("reads a ready snapshot", () => {
    const lex = loadLexicon(makeIndex("ready"))
    expect(lex?.symbols.map((s) => s.name)).toEqual(["renderPanel"])
    expect(lex?.paths).toEqual(["src/panel.ts"])
  })

  test("reads a completed snapshot", () => {
    expect(loadLexicon(makeIndex("completed"))?.symbols.length).toBe(1)
  })

  test("ignores an unfinished snapshot", () => {
    expect(loadLexicon(makeIndex("indexing"))).toBeUndefined()
  })

  test("undefined when the project has no index", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-lex-"))
    roots.push(root)
    expect(loadLexicon(root)).toBeUndefined()
    expect(loadLexicon(undefined)).toBeUndefined()
  })
})
