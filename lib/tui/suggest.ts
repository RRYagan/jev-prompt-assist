// Prompt autosuggest matching: pure, dependency-free, no I/O. Given the token
// the user is currently typing and a project lexicon (symbols + file paths),
// return a short ranked list of completion candidates. Safe to run on every
// keystroke.
//
// Ranking tiers (best first):
//   0 exact (case-insensitive) prefix
//   1 camelCase / initialism prefix   (gp -> getProject)
//   2 subsequence                     (rpnl -> renderPanel)
//   3 substring
//   4 typo tolerance (edit distance 1, first char must match)
// Ties break on: file touched by git / referenced this session, then length.

export type LexiconEntry = {
  name: string
  /** LSP numeric kind, or the idx text kind ("function", "class", …). */
  kind: number | string
  file: string
  signature?: string
  /** Leading doc comment / docstring, when the index carries one. */
  doc?: string
  /** Enclosing container (class/module), when the index carries one. */
  container?: string
  /** Whether the symbol is exported/public. */
  exported?: boolean
  /** 1-based start line of the symbol, when the index carries one. */
  line?: number
}

export type Lexicon = {
  symbols: LexiconEntry[]
  paths: string[]
  /** Distinct language ids seen in the index (e.g. "typescript", "python"). */
  languages?: string[]
  /** Language per indexed file path, for language-aware hints. */
  languageOf?: Record<string, string>
}

export type SuggestionKind = "symbol" | "path" | "mention" | "style" | "context"

export type SuggestionSeverity = "error" | "warn" | "info"

export type Suggestion = {
  /** Text substituted for the typed fragment (completions) or the span (style). */
  value: string
  /** Short display label. */
  label: string
  /** Secondary context, e.g. "function · src/panel.tsx". */
  detail?: string
  kind: SuggestionKind
  /** Source range to replace, for style/grammar findings. */
  span?: { start: number; end: number }
  /** Severity, for style/grammar findings (drives colour). */
  severity?: SuggestionSeverity
  /** Replace the whole draft instead of just the fragment/span. */
  replaceAll?: boolean
  /** Append at the end of the draft instead of replacing the fragment. */
  append?: boolean
}

export type SuggestOptions = {
  limit?: number
  /** Match file paths as `@mentions` (value includes the leading `@`). */
  mention?: boolean
  /** Lowercased paths that should rank first within a tier. */
  hotFiles?: ReadonlySet<string>
  /** Lowercased names that should rank first within a tier. */
  recent?: ReadonlySet<string>
}

// The token under the cursor. There is no cursor API in TuiPromptRef, so we
// treat the end of the draft as the cursor and match the trailing run.
// `\p{L}`/`\p{N}` keep ASCII behaviour identical while also matching
// non-Latin identifiers and words (日本語, Привет, café, العربية).
const FRAGMENT = /([\p{L}\p{N}_$][\p{L}\p{N}_$./-]*)$/u
const MENTION = /@([\p{L}\p{N}_$./-]*)$/u

export function currentFragment(input: string): string {
  const match = FRAGMENT.exec(input)
  return match ? match[1]! : ""
}

/** Returns the trailing `@mention` token including the `@`, or undefined. */
export function currentMention(input: string): string | undefined {
  const match = MENTION.exec(input)
  return match ? `@${match[1]!}` : undefined
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}

/**
 * The draft after accepting `item`, or undefined when it is not actionable.
 *
 * Four shapes, checked in order:
 *  - `span`  — a style/grammar finding: splice its replacement into the span.
 *  - `replaceAll` — a content `sharpen:` rewrite: the value is the whole draft.
 *  - `append` — a content target: add `@file` to the end (single space glue,
 *    never a leading/trailing one).
 *  - otherwise a completion: replace the trailing `fragment`.
 */
export function applySuggestion(input: string, fragment: string, item: Suggestion): string | undefined {
  if (item.span) {
    if (!item.value) return undefined
    const { start, end } = item.span
    if (start < 0 || end > input.length || end <= start) return undefined
    return input.slice(0, start) + item.value + input.slice(end)
  }
  if (item.replaceAll) return item.value || undefined
  if (item.append) {
    if (!item.value) return undefined
    const glue = !input || /\s$/.test(input) ? "" : " "
    return input + glue + item.value
  }
  if (!fragment || !input.endsWith(fragment)) return undefined
  return input.slice(0, input.length - fragment.length) + item.value
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash > 0 ? path.slice(0, slash) : ""
}

const KIND_LABELS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type param",
}

export function symbolKindLabel(kind: number | string | undefined): string {
  if (kind === undefined || kind === null) return ""
  if (typeof kind === "string") return kind
  return KIND_LABELS[kind] ?? ""
}

function initialsOf(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let out = ""
  for (const part of parts) {
    const humps = part.split(/(?=[A-Z])/).filter(Boolean)
    if (humps.length > 1 || /^[A-Z]/.test(part)) {
      for (const hump of humps) out += hump[0]!.toLowerCase()
    } else {
      out += part[0]!.toLowerCase()
    }
  }
  return out
}

function isSubsequence(query: string, target: string): boolean {
  let qi = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++
  }
  return qi === query.length
}

/** True when the edit distance between a and b is exactly 1 (not 0). */
function withinEdit1(a: string, b: string): boolean {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (la > lb) i++
    else if (lb > la) j++
    else {
      i++
      j++
    }
  }
  return edits + (la - i) + (lb - j) === 1
}

type Scored = {
  score: number
  hot: number
  recent: number
  len: number
  label: string
  value: string
  detail?: string
  kind: SuggestionKind
}

type IndexedSymbol = {
  entry: LexiconEntry
  lower: string
  init: string
  fileLower: string
}

type Index = {
  symbols: IndexedSymbol[]
  lower: string[]
  init: string[]
  fileLower: string[]
  paths: string[]
  pathLower: string[]
  baseLower: string[]
}

const indexCache = new WeakMap<Lexicon, Index>()

function buildIndex(lexicon: Lexicon): Index {
  const symbols = (lexicon.symbols ?? [])
    .filter((entry) => entry && typeof entry.name === "string" && entry.name.length > 0)
    .map((entry) => ({
      entry,
      lower: entry.name.toLowerCase(),
      init: initialsOf(entry.name),
      fileLower: (entry.file ?? "").toLowerCase(),
    }))
  symbols.sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0))
  const paths = (lexicon.paths ?? []).filter((path) => typeof path === "string" && path.length > 0)
  return {
    symbols,
    lower: symbols.map((s) => s.lower),
    init: symbols.map((s) => s.init),
    fileLower: symbols.map((s) => s.fileLower),
    paths,
    pathLower: paths.map((p) => p.toLowerCase()),
    baseLower: paths.map((p) => basename(p).toLowerCase()),
  }
}

function getIndex(lexicon: Lexicon): Index {
  let index = indexCache.get(lexicon)
  if (!index) {
    index = buildIndex(lexicon)
    indexCache.set(lexicon, index)
  }
  return index
}

function lowerBound(values: string[], target: string): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function compareScored(a: Scored, b: Scored): number {
  return (
    a.score - b.score ||
    a.hot - b.hot ||
    a.recent - b.recent ||
    a.len - b.len ||
    a.label.localeCompare(b.label)
  )
}

function matchSymbols(
  query: string,
  index: Index,
  limit: number,
  hotFiles: ReadonlySet<string> | undefined,
  recent: ReadonlySet<string> | undefined,
): Scored[] {
  const out: Scored[] = []
  const total = index.symbols.length
  const seen = new Set<string>()

  const add = (i: number, score: number) => {
    if (out.length >= limit) return
    const sym = index.symbols[i]!
    if (seen.has(sym.lower)) return
    seen.add(sym.lower)
    const kindLabel = symbolKindLabel(sym.entry.kind)
    const detail = [kindLabel, sym.entry.file].filter(Boolean).join(" · ") || undefined
    out.push({
      score,
      hot: hotFiles?.has(sym.fileLower) ? 0 : 1,
      recent: recent?.has(sym.lower) ? 0 : 1,
      len: sym.entry.name.length,
      label: sym.entry.name,
      value: sym.entry.name,
      detail,
      kind: "symbol",
    })
  }

  // Tier 0: prefix, via the sorted index.
  for (let i = lowerBound(index.lower, query); i < total && index.lower[i]!.startsWith(query); i++) {
    add(i, 0)
  }

  // Tiers 1-3: only until we have enough candidates.
  if (out.length < limit) {
    for (let i = 0; i < total && out.length < limit; i++) {
      const lower = index.lower[i]!
      if (lower.startsWith(query)) continue // already added
      let score = -1
      if (index.init[i]!.startsWith(query)) score = 1
      else if (isSubsequence(query, lower)) score = 2
      else if (lower.includes(query)) score = 3
      if (score >= 0) add(i, score)
    }
  }

  // Tier 4: typo tolerance, bounded and only when still short.
  if (out.length < limit && query.length >= 4) {
    let examined = 0
    const first = query[0]!
    for (let i = lowerBound(index.lower, first); i < total && examined < 4000; i++) {
      const lower = index.lower[i]!
      if (lower[0] !== first) break
      examined++
      if (out.length >= limit) break
      if (lower.startsWith(query) || seen.has(lower)) continue
      if (Math.abs(lower.length - query.length) > 1) continue
      if (withinEdit1(query, lower)) add(i, 4)
    }
  }

  out.sort(compareScored)
  return out
}

function matchPaths(
  query: string,
  index: Index,
  limit: number,
  opts: { mention?: boolean; hotFiles?: ReadonlySet<string>; recent?: ReadonlySet<string> },
): Scored[] {
  const out: Scored[] = []
  const total = index.paths.length
  const seen = new Set<string>()
  const mention = opts.mention === true

  const add = (i: number, score: number) => {
    if (out.length >= limit) return
    const path = index.paths[i]!
    const value = mention ? `@${path}` : query.includes("/") ? path : basename(path)
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push({
      score,
      hot: opts.hotFiles?.has(index.pathLower[i]!) ? 0 : 1,
      recent: 0,
      len: index.baseLower[i]!.length,
      label: basename(path) || path,
      value,
      detail: dirname(path) || undefined,
      kind: mention ? "mention" : "path",
    })
  }

  for (let i = 0; i < total && out.length < limit; i++) {
    if (index.baseLower[i]!.startsWith(query)) add(i, 0)
  }
  for (let i = 0; i < total && out.length < limit; i++) {
    const pathLower = index.pathLower[i]!
    if (index.baseLower[i]!.startsWith(query)) continue
    const score = pathLower.startsWith(query) ? 1 : pathLower.includes(query) ? 2 : -1
    if (score >= 0) add(i, score)
  }

  out.sort(compareScored)
  return out
}

export function suggest(fragment: string, lexicon: Lexicon, opts: SuggestOptions = {}): Suggestion[] {
  const limit = opts.limit ?? 5
  if (limit <= 0) return []
  const query = fragment.trim().toLowerCase()
  const min = opts.mention ? 1 : 2
  if (query.length < min) return []

  const index = getIndex(lexicon)
  const out: Scored[] = []

  if (opts.mention) {
    out.push(...matchPaths(query, index, limit, opts))
  } else {
    // Symbols rank ahead of paths; paths fill any remaining slots.
    const symbols = matchSymbols(query, index, limit, opts.hotFiles, opts.recent)
    out.push(...symbols)
    if (symbols.length < limit) {
      out.push(...matchPaths(query, index, limit - symbols.length, opts))
    }
  }

  const dedup = new Set<string>()
  const result: Suggestion[] = []
  for (const item of out) {
    if (dedup.has(item.value)) continue
    dedup.add(item.value)
    result.push({ value: item.value, label: item.label, detail: item.detail, kind: item.kind })
    if (result.length >= limit) break
  }
  return result
}
