// ASD-STE100 data layer.
//
// The dictionary and glossary are (c) ASD and are NOT redistributable, so they
// live only in the user's config dir (`~/.config/opencode/jev/ste100/`), fetched
// by `scripts/ste100-fetch.mjs` or imported from a local clone. This module
// loads them defensively: a missing/corrupt file yields an empty, `loaded:false`
// dataset and never throws.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type NonApprovedEntry = {
  word: string
  pos?: string
  useInstead: string[]
  note?: string
}

export type SteData = {
  loaded: boolean
  source?: string
  /** normalized approved word form -> true */
  approved: Set<string>
  /** normalized approved word -> its parts of speech */
  approvedPos: Map<string, Set<string>>
  /** normalized non-approved word -> entry */
  nonApproved: Map<string, NonApprovedEntry>
  /** user glossary terms (normalized, spaces preserved) */
  glossary: Set<string>
  /** individual words that occur in any glossary term */
  glossaryWords: Set<string>
}

/** Dictionary words that are permitted in the `-ing` form (Rule 3.5). */
export const APPROVED_ING: ReadonlySet<string> = new Set([
  "lighting",
  "opening",
  "routing",
  "servicing",
  "mating",
  "missing",
  "remaining",
  "something",
  "during",
])

export function ste100Dir(): string {
  return join(homedir(), ".config", "opencode", "jev", "ste100")
}

export function dictionaryPath(override?: string): string {
  return override && override.length ? override : join(ste100Dir(), "dictionary.json")
}

export function glossaryPath(override?: string): string {
  if (override && override.length) return override
  const primary = join(ste100Dir(), "glossary.txt")
  return existsSync(primary) ? primary : join(ste100Dir(), "glossary.example.txt")
}

/** Lowercase, strip parentheticals/punctuation, collapse whitespace. */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9'’\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Strip the `(prep)`-style part-of-speech annotations from an alternative. */
export function cleanReplacement(text: string): string {
  return text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Copy the casing of `sample` onto `replacement` (ALL CAPS / Capitalized / lower). */
export function applyCase(sample: string, replacement: string): string {
  if (!replacement) return replacement
  const letters = sample.replace(/[^A-Za-z]/g, "")
  if (letters.length > 1 && letters === letters.toUpperCase()) return replacement.toUpperCase()
  if (sample[0] && sample[0] === sample[0].toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1)
  }
  return replacement.toLowerCase()
}

export function emptySteData(): SteData {
  return {
    loaded: false,
    approved: new Set(),
    approvedPos: new Map(),
    nonApproved: new Map(),
    glossary: new Set(),
    glossaryWords: new Set(),
  }
}

function splitForms(forms: unknown): string[] {
  if (typeof forms !== "string") return []
  return forms
    .split(/[^A-Za-z'’-]+/)
    .map((part) => normalizeWord(part))
    .filter(Boolean)
}

function readDictionary(path: string, data: SteData): void {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    source?: string
    approved?: Array<Record<string, unknown>>
    non_approved?: Array<Record<string, unknown>>
  }
  data.source = typeof parsed.source === "string" ? parsed.source : undefined

  const addApproved = (word: string, pos: string) => {
    if (!word) return
    data.approved.add(word)
    let set = data.approvedPos.get(word)
    if (!set) {
      set = new Set()
      data.approvedPos.set(word, set)
    }
    if (pos) set.add(pos)
  }

  for (const raw of parsed.approved ?? []) {
    const word = normalizeWord(String(raw.word ?? ""))
    const pos = String(raw.pos ?? "")
    if (!word) continue
    addApproved(word, pos)
    // Nouns take a regular plural; verbs take the listed forms.
    if (pos === "n") addApproved(`${word}s`, pos)
    for (const form of splitForms(raw.forms)) addApproved(form, pos)
  }

  for (const raw of parsed.non_approved ?? []) {
    const word = normalizeWord(String(raw.word ?? ""))
    if (!word) continue
    const useInstead = Array.isArray(raw.use_instead)
      ? (raw.use_instead as unknown[]).map((value) => String(value)).filter(Boolean)
      : []
    data.nonApproved.set(word, {
      word,
      pos: typeof raw.pos === "string" ? raw.pos : undefined,
      useInstead,
      note: typeof raw.note === "string" ? raw.note : undefined,
    })
  }
}

function readGlossary(path: string, data: SteData): void {
  if (!existsSync(path)) return
  const lines = readFileSync(path, "utf8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.replace(/[#;].*$/, "").trim()
    if (!trimmed) continue
    const term = normalizeWord(trimmed)
    if (!term) continue
    data.glossary.add(term)
    for (const word of term.split(" ")) data.glossaryWords.add(word)
    data.glossary.add(`${term}s`)
  }
}

function readSteData(dictionary: string, glossary: string): SteData {
  const data = emptySteData()
  try {
    if (existsSync(dictionary)) {
      readDictionary(dictionary, data)
      data.loaded = data.approved.size > 0 || data.nonApproved.size > 0
    }
  } catch {
    // Corrupt dictionary: keep whatever loaded, stay silent.
  }
  try {
    readGlossary(glossary, data)
  } catch {
    /* ignore */
  }
  return data
}

const cache = new Map<string, { mtime: number; data: SteData }>()

export function loadSteData(opts: { dictionary?: string; glossary?: string } = {}): SteData {
  const dictionary = dictionaryPath(opts.dictionary)
  const glossary = glossaryPath(opts.glossary)
  let mtime = 0
  try {
    mtime = existsSync(dictionary) ? statSync(dictionary).mtimeMs : 0
  } catch {
    mtime = 0
  }
  const key = `${dictionary}|${glossary}`
  const hit = cache.get(key)
  if (hit && hit.mtime === mtime) return hit.data
  const data = readSteData(dictionary, glossary)
  cache.set(key, { mtime, data })
  return data
}

/** User glossary terms that should suppress a token (whole word match). */
export function isGlossaryWord(data: SteData, word: string): boolean {
  return data.glossary.has(word) || data.glossaryWords.has(word)
}
