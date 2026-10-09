// Script detection for the language-aware tiers.
//
// The English-only tiers (grammar, ASD-STE100) must not fire on a draft written
// in another language: "the quick brown fox" rules are noise over 支払い処理 and
// actively misleading over a Cyrillic draft. This module is pure.

export type Script = "latin" | "cjk" | "hangul" | "other" | "unknown"

const LATIN = /\p{Script=Latin}/u
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u
const HANGUL = /\p{Script=Hangul}/u

/** Letters only (Unicode), so punctuation cannot skew the counts. */
function lettersOf(text: string): string {
  return text.match(/\p{L}+/gu)?.join("") ?? ""
}

/** Dominant script of a draft. */
export function scriptOf(text: string): Script {
  const letters = lettersOf(text)
  if (letters.length === 0) return "unknown"
  let latin = 0
  let cjk = 0
  let hangul = 0
  let other = 0
  for (const ch of letters) {
    if (CJK.test(ch)) cjk++
    else if (HANGUL.test(ch)) hangul++
    else if (LATIN.test(ch)) latin++
    else other++
  }
  const best = Math.max(latin, cjk, hangul, other)
  if (best === 0) return "unknown"
  if (best === latin) return "latin"
  if (best === cjk) return "cjk"
  if (best === hangul) return "hangul"
  return "other"
}

/**
 * True when the English-only tiers should run: the draft is mostly Latin script
 * (or has no letters at all, where they are simply inert).
 */
export function allowsEnglishLint(text: string): boolean {
  const script = scriptOf(text)
  return script === "latin" || script === "unknown"
}
