// Minimal ambient declaration for Bun's built-in SQLite module. The runtime
// (opencode is a Bun binary) resolves `bun:sqlite` natively; this file exists
// only so `tsc` typechecks lib/tui/lexicon.ts without pulling in bun-types.
declare module "bun:sqlite" {
  export interface Statement {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean })
    query(sql: string): Statement
    prepare(sql: string): Statement
    close(): void
  }
}
