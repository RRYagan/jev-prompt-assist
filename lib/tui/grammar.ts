// Safe, high-confidence general grammar checks. Deliberately conservative: each
// rule fires only on a pattern that is wrong regardless of context, so the
// panel can offer a one-key fix. Anything judgemental belongs in style.ts.
import { segmentSentences, type StyleIssue } from "./style"

const MISSPELLINGS: Readonly<Record<string, string>> = {
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  seperated: "separated",
  definately: "definitely",
  teh: "the",
  adn: "and",
  wich: "which",
  untill: "until",
  accomodate: "accommodate",
  tommorow: "tomorrow",
  occured: "occurred",
  embarass: "embarrass",
  goverment: "government",
  neccessary: "necessary",
  necessery: "necessary",
  publically: "publicly",
  reccomend: "recommend",
  recomend: "recommend",
  refrence: "reference",
  calender: "calendar",
  concensus: "consensus",
  arguement: "argument",
  enviroment: "environment",
  existance: "existence",
  independant: "independent",
  maintainance: "maintenance",
  occassion: "occasion",
  persistant: "persistent",
  priviledge: "privilege",
  sucessful: "successful",
  successfull: "successful",
  thier: "their",
  wierd: "weird",
  acheive: "achieve",
  beleive: "believe",
  buisness: "business",
  definatly: "definitely",
  experiance: "experience",
  immediatly: "immediately",
  knowlege: "knowledge",
  langauge: "language",
  libary: "library",
  questionaire: "questionnaire",
  responsability: "responsibility",
  similiar: "similar",
}

const COMPARATIVES = new Set([
  "more",
  "less",
  "better",
  "rather",
  "greater",
  "other",
  "fewer",
  "faster",
  "slower",
  "higher",
  "lower",
  "longer",
  "shorter",
])

const AN_EXCEPTIONS = new Set([
  "hour",
  "hours",
  "honest",
  "honour",
  "honor",
  "heir",
  "herb",
])
const A_EXCEPTIONS = new Set([
  "university",
  "universities",
  "user",
  "users",
  "one",
  "once",
  "unicorn",
  "unique",
  "european",
  "uniform",
  "union",
  "unit",
  "units",
  "usage",
  "useful",
  "usual",
  "utility",
  "utopia",
])

function copyCase(sample: string, replacement: string): string {
  if (sample && sample[0] === sample[0]!.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1)
  }
  return replacement
}

export type GrammarOptions = { limit?: number }

export function lintGrammar(text: string, opts: GrammarOptions = {}): StyleIssue[] {
  const issues: StyleIssue[] = []
  const seen = new Set<string>()
  const add = (
    start: number,
    end: number,
    severity: StyleIssue["severity"],
    rule: string,
    label: string,
    detail: string,
    replacement?: string,
  ) => {
    if (end <= start) return
    const key = `${rule}:${start}:${end}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push({ span: { start, end }, severity, rule, label, detail, replacement })
  }

  // Repeated word (the the).
  const repeatRe = /\b([A-Za-z]+)\s+\1\b/gi
  let match: RegExpExecArray | null
  while ((match = repeatRe.exec(text)) !== null) {
    add(
      match.index,
      match.index + match[0].length,
      "warn",
      "GM-repeat",
      "repeated word",
      `remove the duplicate “${match[1]}”`,
      match[1]!,
    )
  }

  // its' is always wrong.
  const itsRe = /\bits['’]/gi
  while ((match = itsRe.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "warn", "GM-its", "possessive", "write “its”", "its")
  }

  // more/less/... then -> than.
  const thenRe = /\b([A-Za-z]+)\s+then\b/gi
  while ((match = thenRe.exec(text)) !== null) {
    if (!COMPARATIVES.has(match[1]!.toLowerCase())) continue
    const thenStart = match.index + match[0].length - 4
    add(thenStart, thenStart + 4, "warn", "GM-then", "then/than", "use “than” for comparisons", "than")
  }

  // effect (verb) -> affect; a/an + affect (noun) -> effect.
  const effectRe = /\beffect\s+(the|a|an|this|that|these|those|my|your|its|our|their|it|them)\b/gi
  while ((match = effectRe.exec(text)) !== null) {
    add(match.index, match.index + 6, "warn", "GM-affect", "affect/effect", "use the verb “affect”", "affect")
  }
  const affectRe = /\b(the|a|an|this|that)\s+affect\b/gi
  while ((match = affectRe.exec(text)) !== null) {
    const start = match.index + match[0].length - 6
    add(start, start + 6, "warn", "GM-affect", "affect/effect", "use the noun “effect”", "effect")
  }

  // a/an agreement.
  const anRe = /\ban\s+([A-Za-z][a-z]+)/g
  while ((match = anRe.exec(text)) !== null) {
    const word = match[1]!
    const lower = word.toLowerCase()
    const vowelSound = /^[aeiou]/.test(lower) && !A_EXCEPTIONS.has(lower)
    if (vowelSound || AN_EXCEPTIONS.has(lower)) continue
    add(match.index, match.index + 2, "warn", "GM-a-an", "a/an", `use “a ${word}”`, "a")
  }
  const aRe = /\ba\s+([A-Za-z][a-z]+)/g
  while ((match = aRe.exec(text)) !== null) {
    const word = match[1]!
    const lower = word.toLowerCase()
    const vowelSound = /^[aeiou]/.test(lower) || AN_EXCEPTIONS.has(lower)
    if (!vowelSound || A_EXCEPTIONS.has(lower)) continue
    add(match.index, match.index + 1, "warn", "GM-a-an", "a/an", `use “an ${word}”`, "an")
  }

  // Missing capital at the start of a sentence.
  for (const sentence of segmentSentences(text)) {
    const first = sentence.text.match(/[A-Za-z]/)
    if (!first || first.index === undefined) continue
    const ch = first[0]
    if (ch !== ch.toLowerCase() || sentence.text.slice(0, first.index).trim() !== "") continue
    const at = sentence.start + first.index
    add(
      at,
      at + 1,
      "info",
      "GM-capital",
      "sentence case",
      "start the sentence with a capital letter",
      ch.toUpperCase(),
    )
  }

  // Accidental double spaces (never leading indentation).
  const spaceRe = /(?<=\S) {2,}(?=\S)/g
  while ((match = spaceRe.exec(text)) !== null) {
    add(match.index, match.index + match[0].length, "info", "GM-space", "double space", "use one space", " ")
  }

  // Unmatched brackets / quotes.
  const pairs: Array<[string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]
  for (const [open, close] of pairs) {
    const opens = text.split(open).length - 1
    const closes = text.split(close).length - 1
    if (opens !== closes) {
      add(
        text.length > 0 ? text.length - 1 : 0,
        text.length,
        "info",
        "GM-bracket",
        "unmatched bracket",
        `${opens} “${open}” but ${closes} “${close}”`,
      )
      break
    }
  }
  const quotes = text.split('"').length - 1
  if (quotes % 2 === 1) {
    add(
      text.length > 0 ? text.length - 1 : 0,
      text.length,
      "info",
      "GM-quote",
      "unmatched quote",
      "an opening quote has no closing quote",
    )
  }

  // Small misspelling table.
  for (const token of text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    const replacement = MISSPELLINGS[token[0].toLowerCase()]
    if (!replacement || token.index === undefined) continue
    add(
      token.index,
      token.index + token[0].length,
      "warn",
      "GM-spelling",
      "spelling",
      `use “${replacement}”`,
      copyCase(token[0], replacement),
    )
  }

  const limit = opts.limit ?? 6
  const rank: Record<StyleIssue["severity"], number> = { error: 0, warn: 1, info: 2 }
  issues.sort((a, b) => a.span.start - b.span.start || rank[a.severity] - rank[b.severity])
  return issues.slice(0, Math.max(0, limit))
}
