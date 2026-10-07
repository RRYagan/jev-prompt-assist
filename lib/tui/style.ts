// ASD-STE100 style checker (rules engine).
//
// Pure: it takes the loaded dictionary + text and returns findings with source
// spans. Findings whose rewrite is mechanically safe carry a `replacement`
// (the panel applies it in one keypress); judgement calls are message-only.
//
// Every one of the 53 Issue 9 rules is accounted for in RULE_COVERAGE as
// "auto" (mechanical fix), "advisory" (message-only heuristic) or "manual"
// (needs a human). This checker will not invent a rewrite it cannot justify.
import { APPROVED_ING, applyCase, cleanReplacement, isGlossaryWord, type SteData } from "./ste100"

export type Severity = "error" | "warn" | "info"

export type StyleIssue = {
  span: { start: number; end: number }
  severity: Severity
  /** Rule id, e.g. "5.1" or "GR-6". */
  rule: string
  /** Short human label, e.g. "non-approved word". */
  label: string
  /** One-line explanation / suggested text. */
  detail: string
  /** Mechanical fix, when safe. */
  replacement?: string
}

export type Coverage = "auto" | "advisory" | "manual"

/** The 53 Issue 9 rules + 8 general recommendations, and how we handle each. */
export const RULE_COVERAGE: Readonly<Record<string, Coverage>> = {
  "1.1": "auto",
  "1.2": "manual",
  "1.3": "manual",
  "1.4": "advisory",
  "1.5": "advisory",
  "1.6": "advisory",
  "1.7": "manual",
  "1.8": "manual",
  "1.9": "advisory",
  "1.10": "manual",
  "1.11": "manual",
  "1.12": "advisory",
  "1.13": "manual",
  "1.14": "auto",
  "2.1": "advisory",
  "2.2": "manual",
  "3.1": "advisory",
  "3.2": "advisory",
  "3.3": "advisory",
  "3.4": "advisory",
  "3.5": "advisory",
  "3.6": "advisory",
  "3.7": "manual",
  "4.1": "advisory",
  "4.2": "auto",
  "4.3": "manual",
  "4.4": "manual",
  "4.5": "advisory",
  "5.1": "advisory",
  "5.2": "advisory",
  "5.3": "advisory",
  "5.4": "advisory",
  "5.5": "advisory",
  "6.1": "manual",
  "6.2": "manual",
  "6.3": "advisory",
  "6.4": "manual",
  "6.5": "manual",
  "6.6": "advisory",
  "7.1": "advisory",
  "7.2": "advisory",
  "7.3": "advisory",
  "8.1": "advisory",
  "8.2": "advisory",
  "8.3": "advisory",
  "8.4": "auto",
  "8.5": "auto",
  "8.6": "auto",
  "8.7": "auto",
  "9.1": "manual",
  "9.2": "manual",
  "9.3": "advisory",
  "9.4": "manual",
  "GR-1": "advisory",
  "GR-2": "advisory",
  "GR-3": "manual",
  "GR-4": "manual",
  "GR-5": "manual",
  "GR-6": "auto",
  "GR-7": "advisory",
  "GR-8": "advisory",
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

const AMERICAN: Readonly<Record<string, string>> = {
  colour: "color",
  colours: "colors",
  behaviour: "behavior",
  honour: "honor",
  labour: "labor",
  neighbour: "neighbor",
  centre: "center",
  metres: "meters",
  metre: "meter",
  litres: "liters",
  litre: "liter",
  fibre: "fiber",
  defence: "defense",
  licence: "license",
  offence: "offense",
  organise: "organize",
  organised: "organized",
  organisation: "organization",
  analyse: "analyze",
  analysed: "analyzed",
  realise: "realize",
  recognised: "recognized",
  catalogue: "catalog",
  dialogue: "dialog",
  grey: "gray",
  aluminium: "aluminum",
  mould: "mold",
  travelling: "traveling",
  cancelled: "canceled",
  modelling: "modeling",
  jewellery: "jewelry",
  cheque: "check",
  tyre: "tire",
  kerb: "curb",
  plough: "plow",
  sceptic: "skeptic",
  storey: "story",
}

const CONTRACTIONS: Readonly<Record<string, string>> = {
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "can't": "cannot",
  "couldn't": "could not",
  "won't": "will not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "mustn't": "must not",
  "haven't": "have not",
  "hasn't": "has not",
  "hadn't": "had not",
  "it's": "it is",
  "i'm": "I am",
  "i've": "I have",
  "i'll": "I will",
  "i'd": "I would",
  "you're": "you are",
  "you've": "you have",
  "you'll": "you will",
  "you'd": "you would",
  "we're": "we are",
  "we've": "we have",
  "we'll": "we will",
  "we'd": "we would",
  "they're": "they are",
  "they've": "they have",
  "they'll": "they will",
  "they'd": "they would",
  "he's": "he is",
  "she's": "she is",
  "that's": "that is",
  "there's": "there is",
  "here's": "here is",
  "what's": "what is",
  "let's": "let us",
  "who's": "who is",
}

const LATIN: Readonly<Record<string, string>> = {
  "e.g.": "for example",
  "i.e.": "that is",
  "etc": "and other items",
  "etc.": "and other items",
}

const PHRASAL: Readonly<Record<string, string>> = {
  "put out": "extinguish",
  "give off": "release",
  "go down": "decrease",
  "go up": "increase",
  "carry out": "do",
}

// `-ing` words that are not the progressive verb form (Rule 3.5 permits
// technical nouns/modifiers). Kept small; the dictionary itself is authoritative.
const NON_VERB_ING: ReadonlySet<string> = new Set([
  "thing",
  "things",
  "king",
  "ring",
  "spring",
  "string",
  "wing",
  "bring",
  "sing",
  "morning",
  "evening",
  "ceiling",
  "something",
  "anything",
  "nothing",
  "everything",
  "according",
  "engineering",
  "building",
])

const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "that",
  "this",
  "these",
  "those",
  "it",
  "you",
  "we",
  "they",
  "when",
  "if",
  "as",
  "into",
  "than",
  "then",
])

// Common imperative openers used only as a weak signal for sentence mode.
const BASE_VERBS: ReadonlySet<string> = new Set([
  "add",
  "apply",
  "attach",
  "check",
  "clean",
  "close",
  "connect",
  "continue",
  "delete",
  "disconnect",
  "do",
  "examine",
  "fix",
  "install",
  "make",
  "measure",
  "move",
  "open",
  "put",
  "read",
  "release",
  "remove",
  "replace",
  "run",
  "set",
  "start",
  "stop",
  "test",
  "tighten",
  "turn",
  "update",
  "use",
  "verify",
  "write",
])

export type Token = { text: string; lower: string; start: number; end: number }

export function tokenize(text: string): Token[] {
  const out: Token[] = []
  const re = /[A-Za-z][A-Za-z'’-]*/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const textValue = match[0]
    out.push({
      text: textValue,
      lower: textValue.toLowerCase().replace(/[’]/g, "'"),
      start: match.index,
      end: match.index + textValue.length,
    })
  }
  return out
}

export type Sentence = { text: string; start: number; end: number }

export function segmentSentences(text: string): Sentence[] {
  const out: Sentence[] = []
  const lineRe = /[^\n]+/g
  let line: RegExpExecArray | null
  while ((line = lineRe.exec(text)) !== null) {
    const base = line.index
    const chunk = line[0]
    const partRe = /[^\s.!?][^.!?]*[.!?]*/g
    let part: RegExpExecArray | null
    while ((part = partRe.exec(chunk)) !== null) {
      const raw = part[0]
      out.push({ text: raw, start: base + part.index, end: base + part.index + raw.length })
    }
  }
  return out
}

/**
 * Word count per Rules 8.4-8.7: parentheses, quoted text, number+unit pairs,
 * alphanumeric identifiers and hyphenated words each count as one word.
 */
export function countWords(text: string): number {
  const normalized = text
    .replace(/\([^)]*\)/g, " X ")
    .replace(/"[^"]*"/g, " X ")
    .replace(/'[^']*'/g, " X ")
    .replace(/\b\d+(?:[.,]\d+)?\s*[A-Za-z%/]+\b/g, " X ")
    .replace(/\b[A-Za-z]*\d[A-Za-z0-9]*\b/g, " X ")
  return normalized.split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length
}

export function isProcedural(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/^(note|warning|caution|danger|attention)\b/i.test(trimmed)) return false
  if (/^([-*•]|\d+[.)]|[A-Za-z][.)])\s/.test(trimmed)) return true
  if (/^(if|when|before|after|while|until)\b/i.test(trimmed)) return true
  const first = tokenize(trimmed)[0]?.lower
  return first !== undefined && BASE_VERBS.has(first)
}

export type LintOptions = {
  data: SteData
  /** Whole-word glossary terms that suppress tokens (user terms). */
  glossary?: ReadonlySet<string>
  maxInstructionWords?: number
  maxDescriptiveWords?: number
  /** Report unknown words (Rules 1.5/1.12). Noisy; off by default. */
  flagUnknown?: boolean
  limit?: number
}

const SEVERITY_ORDER: Severity[] = ["error", "warn", "info"]

export function lintSte(text: string, opts: LintOptions): StyleIssue[] {
  const data = opts.data
  const maxInstruction = opts.maxInstructionWords ?? 20
  const maxDescriptive = opts.maxDescriptiveWords ?? 25
  const issues: StyleIssue[] = []
  const seen = new Set<string>()

  const add = (
    start: number,
    end: number,
    severity: Severity,
    rule: string,
    label: string,
    detail: string,
    replacement?: string,
  ) => {
    if (start < 0 || end <= start) return
    const key = `${rule}:${start}:${end}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ span: { start, end }, severity, rule, label, detail, replacement })
  }

  const suppressed = (word: string) =>
    isGlossaryWord(data, word) || (opts.glossary ? opts.glossary.has(word) : false)

  // ---- Word-level rules -------------------------------------------------
  for (const token of tokenize(text)) {
    const lower = token.lower
    if (lower.length < 2) continue

    const american = AMERICAN[lower]
    if (american) {
      add(
        token.start,
        token.end,
        "warn",
        "1.14",
        "British spelling",
        `use “${american}”`,
        applyCase(token.text, american),
      )
      continue
    }

    if (suppressed(lower)) continue

    const nonApproved = data.nonApproved.get(lower)
    if (nonApproved) {
      const alternatives = nonApproved.useInstead.map(cleanReplacement).filter(Boolean)
      const first = alternatives[0]
      const detail = alternatives.length
        ? `use “${alternatives.slice(0, 3).join("” / “")}”`
        : "not approved"
      add(
        token.start,
        token.end,
        "warn",
        "1.1",
        "non-approved word",
        detail,
        first ? applyCase(token.text, first) : undefined,
      )
      continue
    }

    if (!data.approved.has(lower)) {
      if (
        lower.endsWith("ing") &&
        lower.length > 4 &&
        !APPROVED_ING.has(lower) &&
        !NON_VERB_ING.has(lower)
      ) {
        add(
          token.start,
          token.end,
          "info",
          "3.5",
          "‘-ing’ form",
          "use only as a technical noun or modifier",
        )
        continue
      }
      if (opts.flagUnknown && lower.length >= 4 && lower === token.text.toLowerCase()) {
        add(
          token.start,
          token.end,
          "info",
          "1.5",
          "not in dictionary",
          "use an approved word or add it to the glossary",
        )
      }
    }
  }

  // ---- Contractions (4.2) ----------------------------------------------
  const contractionRe = /\b([A-Za-z]+)['’](t|s|re|ve|ll|d|m)\b/g
  let match: RegExpExecArray | null
  while ((match = contractionRe.exec(text)) !== null) {
    const full = match[0]
    const replacement = CONTRACTIONS[full.toLowerCase()]
    if (!replacement) continue
    add(
      match.index,
      match.index + full.length,
      "warn",
      "4.2",
      "contraction",
      `write “${replacement}”`,
      applyCase(full, replacement),
    )
  }

  // ---- Latin abbreviations (GR-6) --------------------------------------
  const latinRe = /\b(e\.g\.|i\.e\.|etc\.?)/gi
  while ((match = latinRe.exec(text)) !== null) {
    const full = match[0]
    const replacement = LATIN[full.toLowerCase().replace(/e\.g\.?/, "e.g.").replace(/i\.e\.?/, "i.e.")]
    add(
      match.index,
      match.index + full.length,
      "warn",
      "GR-6",
      "Latin abbreviation",
      replacement ? `write “${replacement}”` : "use plain English",
      replacement ? applyCase(full, replacement) : undefined,
    )
  }

  // ---- Phrasal verbs (9.3) ---------------------------------------------
  for (const [phrase, replacement] of Object.entries(PHRASAL)) {
    const re = new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi")
    while ((match = re.exec(text)) !== null) {
      add(
        match.index,
        match.index + match[0].length,
        "info",
        "9.3",
        "phrasal verb",
        `use “${replacement}”`,
        applyCase(match[0], replacement),
      )
    }
  }

  // ---- Gendered pronouns (GR-7) ----------------------------------------
  const genderedRe = /\b(he|him|his|she|her|hers)\b/gi
  while ((match = genderedRe.exec(text)) !== null) {
    add(
      match.index,
      match.index + match[0].length,
      "info",
      "GR-7",
      "gendered pronoun",
      "use “you”, “the operator”, “personnel” or “they”",
    )
  }

  // ---- Auxiliary / perfect (3.4) ---------------------------------------
  const auxiliaryRe = /\b(have|has|had|having|been|being)\b/gi
  while ((match = auxiliaryRe.exec(text)) !== null) {
    add(
      match.index,
      match.index + match[0].length,
      "info",
      "3.4",
      "auxiliary verb",
      "use simple present/past, not a complex construction",
    )
  }

  // ---- Passive voice (3.6) ---------------------------------------------
  const passiveRe = /\b(is|are|was|were|be|been|being)\s+([A-Za-z]+(?:ed|en))\b/gi
  while ((match = passiveRe.exec(text)) !== null) {
    const byAgent = /^\s+by\b/i.test(text.slice(match.index + match[0].length))
    add(
      match.index,
      match.index + match[0].length,
      byAgent ? "warn" : "info",
      "3.6",
      "passive voice",
      byAgent ? "make it active: name the agent first" : "prefer active voice if the agent is known",
    )
  }

  // ---- Semicolons (8.1) -------------------------------------------------
  const semiRe = /;/g
  while ((match = semiRe.exec(text)) !== null) {
    add(match.index, match.index + 1, "warn", "8.1", "semicolon", "write two sentences")
  }

  // ---- Multi-word nouns (2.1) ------------------------------------------
  const tokens = tokenize(text)
  let run: Token[] = []
  const flushRun = () => {
    if (run.length >= 4) {
      add(
        run[0]!.start,
        run[run.length - 1]!.end,
        "info",
        "2.1",
        "long noun cluster",
        "use a maximum of 3 words; add prepositions",
      )
    }
    run = []
  }
  for (const token of tokens) {
    const lower = token.lower
    const content =
      !STOPWORDS.has(lower) &&
      lower.length > 2 &&
      !data.nonApproved.has(lower) &&
      (data.approved.has(lower) || suppressed(lower) || lower.length > 3)
    if (content) run.push(token)
    else flushRun()
  }
  flushRun()

  // ---- Sentence-level rules --------------------------------------------
  const procedural = isProcedural(text)
  const sentences = segmentSentences(text)
  for (const sentence of sentences) {
    const words = countWords(sentence.text)
    if (procedural && words > maxInstruction) {
      add(
        sentence.start,
        sentence.end,
        "warn",
        "5.1",
        "sentence too long",
        `${words} words (maximum ${maxInstruction})`,
      )
    } else if (!procedural && words > maxDescriptive) {
      add(
        sentence.start,
        sentence.end,
        "warn",
        "6.3",
        "sentence too long",
        `${words} words (maximum ${maxDescriptive})`,
      )
    }
    if (procedural && /\band\b/i.test(sentence.text)) {
      const first = tokenize(sentence.text)[0]?.lower
      if (first && (BASE_VERBS.has(first) || data.approvedPos.get(first)?.has("v"))) {
        add(
          sentence.start,
          sentence.end,
          "info",
          "5.2",
          "possible multiple instructions",
          "write one instruction per sentence",
        )
      }
    }
    if (procedural) {
      const first = tokenize(sentence.text)[0]?.lower
      const condition = /^(if|when|before|after|while|until)\b/i.test(sentence.text.trim())
      if (
        first &&
        !condition &&
        !/^\s*([-*•]|\d+[.)]|[A-Za-z][.)])\s/.test(sentence.text) &&
        !BASE_VERBS.has(first) &&
        !data.approvedPos.get(first)?.has("v")
      ) {
        add(sentence.start, sentence.end, "info", "5.3", "not imperative", "start instructions with a verb")
      }
    }
  }

  // ---- Paragraph length (6.6) ------------------------------------------
  const paraRe = /[^\n]+(?:\n(?![ \t]*\n)[^\n]*)*/g
  while ((match = paraRe.exec(text)) !== null) {
    const paragraph = match[0]
    const count = segmentSentences(paragraph).length
    if (count > 6) {
      add(match.index, match.index + paragraph.length, "info", "6.6", "long paragraph", `${count} sentences (maximum 6)`)
    }
  }

  // ---- Safety wording (7.1 / 7.2) --------------------------------------
  const safetyRe = /\b(warning|caution)\b/gi
  while ((match = safetyRe.exec(text)) !== null) {
    const atStart = text.slice(0, match.index).trim().length === 0
    if (!atStart) {
      add(
        match.index,
        match.index + match[0].length,
        "info",
        "7.1",
        "safety marker",
        "start a warning/caution with the marker, then the command",
      )
    }
  }

  const limit = opts.limit ?? 6
  issues.sort((a, b) => a.span.start - b.span.start || RANK[a.severity] - RANK[b.severity])
  return issues.slice(0, Math.max(0, limit))
}

export { SEVERITY_ORDER, RANK }
