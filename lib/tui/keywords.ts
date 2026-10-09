// keywords.ts — language-independent keyword extraction for index queries.
//
// Design constraints
//  - No tokenizer dependency: Unicode property escapes + NFKD diacritic folding,
//    so `cafe`, `café` and `CAFE` all reach the same index rows.
//  - Script aware: unicode61 (the tokenizer inside the idx FTS5 table) splits on
//    ASCII/Cyrillic punctuation but treats an unbroken CJK run as ONE token, so a
//    CJK run is expanded into bigrams plus the run itself (the bigrams also drive
//    a `LIKE` substring probe in content.ts).
//  - Deterministic ordering: weight = position weighting summed over hits.
//    Keywords that only a generic-action filter would be dropped only when they
//    never carry the request.

export interface KeywordOptions {
  /** Max keywords to return (default 6). */
  limit?: number
  /** Extra words to drop even when frequent (e.g. project stopwords). */
  stop?: Iterable<string>
}

/** Very small English stop list — other languages rely on the generic filters. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "be", "that", "this", "it", "as", "at", "by", "from",
])

/**
 * Function words of the most common request languages. They are never the topic
 * of a request, and every one of them steals a slot from the keyword budget —
 * "arreglar el reembolso de pagos" would otherwise spend two of five slots on
 * filler. Deliberately conservative, so code identifiers still survive; a
 * project whose real nouns collide can drop them via the `stop` option.
 */
const FOREIGN_STOPWORDS = new Set([
  // Spanish / Portuguese / French (2-letter function words, still frequent)
  "el", "los", "las", "del", "para", "por", "con", "que", "está", "esta", "sobre",
  "como", "mas", "más", "não", "nao", "dos", "das", "nos", "uma", "com", "de",
  "le", "les", "des", "dans", "pour", "sur", "avec", "est", "sont", "aux", "cette",
  "tout", "du", "au",
  // German
  "der", "die", "das", "den", "dem", "und", "ist", "ein", "eine", "einen",
  "einem", "mit", "für", "fur", "von", "auf", "nicht", "auch", "sich", "aus", "als",
  "bei", "wird", "werden",
  // Italian ("il" is kept: it is a common abbreviation in compiler code)
  "gli", "che", "non", "sono", "dei", "nel", "alla", "dalla", "come",
  // Dutch / Nordic (length >= 3, so identifiers stay intact)
  "det", "att", "och", "som", "för", "van", "een", "niet", "ikke", "eller",
])

/** English action boilerplate — the imperative half of any request. */
const ACTION_WORDS = [
  "implement", "extract", "optimize", "investigate", "explain", "verify",
  "ensure", "build", "run", "convert", "migrate", "support", "avoid",
  "reduce", "simplify", "replace", "revert", "review", "refactor", "rename",
  "document", "test", "move", "create", "remove", "delete",
]

/**
 * English boilerplate that would otherwise dominate any English draft: action
 * verbs and the nouns every software request contains. Mirrors the ACTION list
 * in analyze.ts so the two tiers agree on what is not a topic.
 */
const GENERIC = new Set([
  "add", "update", "updated", "fix", "make", "use", "using", "new", "want",
  "need", "please", "code", "file", "files", "function", "class", "method",
  "module", "logic", "thing", "stuff", "something", "work", "works", "working",
  "change", "changes", "check", "look", "see", "get", "got", "let", "lets",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "do", "does", "done", "doing", "just", "also", "then", "than", "when", "where",
  "what", "why", "how", "who", "which", "into", "over", "under", "after",
  "before", "between", "all", "any", "some", "each", "every", "now", "here",
  "there", "i", "we", "you", "my", "our", "your", "me", "us", "help",
  ...ACTION_WORDS,
])

/**
 * Fold a token the way the idx FTS tokenizer does.
 *
 * The index runs `unicode61 remove_diacritics 2`: that strips diacritics from
 * Latin letters (`café` -> `cafe`) but does NOT decompose other scripts
 * (`платежей` and `결제` stay whole). A blanket NFKD+mark-strip would therefore
 * break Cyrillic, Hangul and Thai, so folding is limited to Latin accents.
 */
function fold(input: string): string {
  const lower = input.toLowerCase()
  if (!/[\u00C0-\u024F\u1E00-\u1EFF]/.test(lower)) return lower
  return lower.normalize("NFKD").replace(/\p{M}+/gu, "")
}

/** File extensions: noise in every path, never the topic of a request. */
const EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb",
  "php", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "json", "md", "yaml",
  "yml", "toml", "sh", "css", "html", "sql", "vue", "svelte",
])

/**
 * Split a latin token into its semantic parts: camelCase, snake_case, kebab,
 * dots and slashes. `src/pay.ts` -> src, pay.
 */
function splitParts(token: string): string[] {
  const out: string[] = []
  for (const chunk of token.split(/[_.\-/]+/)) {
    for (const part of splitLatin(chunk)) out.push(part)
  }
  return out.filter((part) => part.length > 0)
}

/** Split a latin identifier into its semantic parts: camelCase, snake_case, kebab. */
function splitLatin(token: string): string[] {
  const parts: string[] = []
  let cur = ""
  let prevKind = ""
  for (const ch of token) {
    const upper = ch !== ch.toLowerCase()
    const lower = ch !== ch.toUpperCase()
    // "U" is an upper-case-only character, "l" a lower-case-only one, "*" neither.
    const kind = upper && !lower ? "U" : lower && !upper ? "l" : "*"
    if (cur && kind !== prevKind && kind !== "*" && prevKind !== "*") {
      parts.push(cur)
      cur = ch
    } else {
      cur += ch
    }
    prevKind = kind
  }
  if (cur) parts.push(cur)
  return parts.filter((part) => part.length > 0)
}

/**
 * True for scripts written without spaces, where one token is a whole phrase.
 *
 * Hangul is deliberately excluded: Korean (eojeol) is written with spaces, so
 * the FTS tokenizer already splits it and a substring probe is not needed.
 */
function isCjkRun(token: string): boolean {
  for (const ch of token) {
    const code = ch.codePointAt(0)!
    const ideographic = code >= 0x3400 && code <= 0x9fff
    const kana = code >= 0x3040 && code <= 0x30ff
    const compat = code >= 0xf900 && code <= 0xfaff
    if (!ideographic && !kana && !compat) return false
  }
  return token.length > 0
}

/** A CJK run as bigrams (unicode61 keeps the run whole) plus the run itself. */
function cjkVariants(token: string, maxBigramLength = 6): string[] {
  const out: string[] = []
  if (token.length < 2) return out
  const cap = Math.min(token.length, maxBigramLength)
  for (let i = 0; i + 1 < cap; i++) out.push(token.slice(i, i + 2))
  if (token.length <= maxBigramLength) out.push(token)
  return out
}

interface Slot {
  key: string
  hits: number
  weight: number
  length: number
  seq: number
}

/**
 * Extract ranked search keywords from free text (a prompt draft or a task).
 *
 * Returns folded, lowercase keywords ordered by (frequency, position weight)
 * then shorter-first. Ties in weight prefer the keyword seen earlier.
 */
export function extractKeywords(text: string, opts: KeywordOptions = {}): string[] {
  const limit = Math.max(1, opts.limit ?? 6)
  const extraStop = new Set<string>()
  if (opts.stop) for (const word of opts.stop) extraStop.add(fold(word.toLowerCase()))

  const tokens =
    String(text ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_$./-]*/gu) ?? []
  const slots = new Map<string, Slot>()
  const total = Math.max(1, tokens.length)

  const add = (key: string, weight: number, seq: number) => {
    const slot = slots.get(key)
    if (slot) {
      slot.hits += 1
      slot.weight += weight
      return
    }
    slots.set(key, { key, hits: 1, weight, length: key.length, seq: order++ })
  }
  let order = 0

  tokens.forEach((token, index) => {
    // Trailing separators are noise ("src/" -> "src").
    const trimmed = token.replace(/^[._\-/]+/, "").replace(/[._\-/]+$/, "")
    if (!trimmed) return
    // Earlier words weigh more: the lead of a request is its subject.
    const weight = 1 + (1 - index / total)

    if (isCjkRun(trimmed)) {
      for (const variant of cjkVariants(trimmed)) add(variant, weight, index)
      return
    }
    for (const word of splitParts(trimmed)) {
      const key = fold(word)
      if (key.length < 2) continue
      if (STOPWORDS.has(key) || FOREIGN_STOPWORDS.has(key) || GENERIC.has(key) || EXTENSIONS.has(key)) continue
      if (extraStop.has(key)) continue
      add(key, weight, index)
    }
    // Keep an underscore identifier whole: unicode61 splits on `_`, so a
    // phrase query for `refund_amount_cents` is the only way to rank a symbol
    // with that exact name. Kebab and camel forms are already covered by the
    // parts above (and by a prefix match on the whole token).
    if (trimmed.includes("_")) {
      const whole = fold(trimmed)
      if (whole.length >= 3) add(whole, weight, index)
    }
  })

  return [...slots.values()]
    .sort((a, b) => {
      const delta = b.weight - a.weight
      if (Math.abs(delta) > 1e-9) return delta
      // Equal weight: keep the order the words appeared in the request (the
      // leading part of an identifier is the one the user cares about).
      return a.seq - b.seq
    })
    .slice(0, limit)
    .map((slot) => slot.key)
}

/**
 * Split keywords into the groups the content index has to query differently.
 * FTS5 `unicode61` honours spaces and punctuation for spaced scripts and only
 * understands substring probes for packed (CJK) runs.
 */
export function splitByScript(keywords: string[]): { spaced: string[]; packed: string[] } {
  const spaced: string[] = []
  const packed: string[] = []
  for (const key of keywords) {
    if (isCjkRun(key)) packed.push(key)
    else spaced.push(key)
  }
  return { spaced, packed }
}

/** Quote an FTS5 term so punctuation or operators cannot break the MATCH. */
export function ftsTerm(keyword: string): string {
  const cleaned = keyword.replace(/["*\s()^:]/g, "")
  return cleaned ? `"${cleaned}"` : ""
}

/** Escape a LIKE pattern (only `\`, `%` and `_` are special). */
export function likeTerm(keyword: string): string {
  return keyword.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}
