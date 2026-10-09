// Content-index suggestions: turn a rough draft ("update payment") into the
// concrete files, functions and docs that own it, then offer a sharpened
// version of the draft that names those targets.
//
// Pure: takes the hits the content index already produced (no I/O), so it is
// safe on the keystroke path and trivially testable.
import type { ContentHit } from "./content"
import { basename, dirname, type Suggestion } from "./suggest"

export interface ContextOptions {
  /** Max hits to surface as suggestions (default 4). */
  limit?: number
  /** Offer the file as an `@mention` rather than a bare path. */
  mention?: boolean
}

/**
 * Suggestions from content-index hits:
 *   1. one `sharpen:` entry that rewrites the draft with the matched targets
 *      (`replaceAll`)
 *   2. one append-only entry per hit, so the draft gains `@file` at the end
 */
export function contextSuggestions(
  draft: string,
  hits: readonly ContentHit[] | undefined,
  opts: ContextOptions = {},
): Suggestion[] {
  const top = (hits ?? []).filter((hit) => hit && typeof hit.file === "string" && hit.file).slice(
    0,
    Math.max(1, opts.limit ?? 4),
  )
  if (top.length === 0) return []

  const mention = opts.mention === true
  const out: Suggestion[] = []
  const text = String(draft ?? "")

  // Accepting a rewrite pins the targets; offering it again on every later
  // keystroke would be noise. `draftPrompt` always starts the block on a new
  // line, so its presence is an exact marker.
  const alreadyPinned = text.includes("\nTarget:")

  const sharpened = draftPrompt(text, top)
  if (!alreadyPinned && sharpened && sharpened !== text) {
    out.push({
      value: sharpened,
      label: "sharpen: pin the indexed targets",
      detail: `${top.length} match${top.length === 1 ? "" : "es"} → Target + Symbols`,
      kind: "context",
      replaceAll: true,
    })
  }

  for (const hit of top) {
    out.push({
      value: `${mention ? "@" : ""}${hit.file}`,
      label: hit.symbol ?? basename(hit.file),
      detail: hitDetail(hit),
      kind: "context",
      append: true,
    })
  }
  return out
}

/** Compact secondary line for a hit: where it lives, what matched it. */
function hitDetail(hit: ContentHit): string {
  const parts: string[] = []
  const folder = dirname(hit.file)
  if (folder) parts.push(folder.length > 34 ? `…${folder.slice(-33)}` : folder)
  if (hit.line) parts.push(`L${hit.line}`)
  if (hit.language && hit.language !== "unknown") parts.push(hit.language)
  if (hit.keywords.length > 0) parts.push(`matched: ${hit.keywords.slice(0, 3).join(" ")}`)
  return parts.join(" · ").slice(0, 78)
}

/**
 * Rewrite the draft so it names the targets the index found.
 *
 * The original wording is preserved verbatim (the user's ask is the spec); only
 * a `Target:`/`Symbols:` block is appended. Criteria stay with the caller that
 * knows the task, e.g. the `jev_context` server tool.
 */
export function draftPrompt(draft: string, hits: readonly ContentHit[], maxFiles = 3): string {
  const text = String(draft ?? "").trim()
  const top = (hits ?? []).filter((hit) => hit && hit.file).slice(0, maxFiles)
  if (top.length === 0) return text
  const named = top.filter((hit) => hit.symbol && !hit.symbol.includes(" "))
  const lines = [text]
  lines.push(`Target: ${top.map((hit) => hit.file).join(", ")}`)
  if (named.length > 0) {
    lines.push(
      `Symbols: ${named
        .slice(0, 3)
        .map((hit) => (hit.line ? `${hit.symbol} (${basename(hit.file)}:${hit.line})` : `${hit.symbol}`))
        .join(", ")}`,
    )
  }
  return lines.join("\n")
}
