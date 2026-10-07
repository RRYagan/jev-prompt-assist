// Prompt autosuggest matching: pure, dependency-free, no I/O. Given the
// fragment the user is currently typing and a project lexicon (symbols +
// file paths loaded from the idx index), return a short ranked list of
// completion candidates. Safe to run on every keystroke.

export type LexiconEntry = {
  name: string
  kind: number
  file: string
  signature?: string
}

export type Lexicon = {
  symbols: LexiconEntry[]
  paths: string[]
}

// The token under the cursor. There is no cursor API in TuiPromptRef, so we
// treat the end of the draft as the cursor and match the trailing
// identifier/path run.
const FRAGMENT = /([A-Za-z_$][A-Za-z0-9_$./-]*)$/

export function currentFragment(input: string): string {
  const match = FRAGMENT.exec(input)
  return match ? match[1]! : ""
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash >= 0 ? path.slice(slash + 1) : path
}

function displayPath(path: string, query: string): string {
  // A bare token shows just the file name; a path-like fragment shows the path.
  return query.includes("/") ? path : basename(path) || path
}

export function suggestFor(fragment: string, lexicon: Lexicon, limit = 5): string[] {
  const query = fragment.trim().toLowerCase()
  if (query.length < 2 || limit <= 0) return []

  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string) => {
    if (!value || seen.has(value) || out.length >= limit) return
    seen.add(value)
    out.push(value)
  }

  const symbols = lexicon.symbols
    .filter((entry) => entry.name.toLowerCase().startsWith(query))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
  for (const entry of symbols) push(entry.name)

  if (out.length < limit) {
    const paths = lexicon.paths
      .filter((path) => {
        const lower = path.toLowerCase()
        return basename(lower).startsWith(query) || lower.includes(query)
      })
      .sort((a, b) => {
        const ap = basename(a.toLowerCase()).startsWith(query) ? 0 : 1
        const bp = basename(b.toLowerCase()).startsWith(query) ? 0 : 1
        return (
          ap - bp ||
          basename(a).length - basename(b).length ||
          a.length - b.length ||
          a.localeCompare(b)
        )
      })
    for (const path of paths) push(displayPath(path, query))
  }

  return out
}
