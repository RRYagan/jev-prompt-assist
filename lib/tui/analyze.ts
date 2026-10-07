// Tier-1 analysis: instant, dependency-free heuristics that score prompt
// sentences/paragraphs and suggest fixes. No model, no I/O — safe to run on
// every keystroke.

export type Level = "good" | "ok" | "weak"

export type SegmentScore = {
  text: string
  score: number
  level: Level
  tips: string[]
}

export type Analysis = {
  score: number
  level: Level
  segments: SegmentScore[]
  tips: string[]
  tier: "heuristic" | "s1"
}

export function levelFor(score: number): Level {
  if (score >= 0.7) return "good"
  if (score >= 0.4) return "ok"
  return "weak"
}

/** Split a draft into sentence-sized segments (falls back to punctuation). */
export function segmentText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" })
    const out = Array.from(segmenter.segment(trimmed))
      .map((part) => part.segment.trim())
      .filter(Boolean)
    if (out.length > 0) return out
  } catch {
    /* fall through */
  }
  return trimmed
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

const VAGUE =
  /\b(something|stuff|things?|etc|whatever|somehow|some\s+way|fix\s+it|do\s+it|make\s+it\s+better|as\s+good\s+as\s+possible|handle\s+it|and\s+so\s+on)\b/i
const HEDGE =
  /\b(maybe|perhaps|possibly|probably|i\s+think|kind\s+of|sort\s+of|might\s+want|if\s+you\s+can|when\s+you\s+get\s+a\s+chance)\b/i
const ACTION =
  /^(add|remove|delete|fix|refactor|rename|implement|write|update|change|create|move|extract|test|document|optimize|improve|investigate|explain|find|check|verify|ensure|make|build|run|convert|migrate|support|handle|avoid|reduce|simplify|clean|use|replace|revert|review)\b/i
const CRITERIA =
  /\b(must|should|so\s+that|so\s+it|acceptance|expected|verify|ensure|test\s+that|when\s+.+\s+then|within|without|instead\s+of|edge\s+case|error|cover|only|exactly|before|after)\b/i
const SPECIFIC =
  /(`[^`]+`|[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|yaml|yml|toml|sh|css|html|sql)|\/[\w./-]+|\b\d+\b|\b[A-Za-z_]\w*\()/
const QUESTION_START = /^(what|why|how|when|where|who|which|can|could|should|is|are|do|does|did)\b/i

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** Score a single sentence/segment and collect actionable tips. */
export function scoreSegment(text: string): SegmentScore {
  const tips: string[] = []
  let score = 0.5
  const len = text.trim().length

  if (len < 12) {
    score -= 0.3
    tips.push("Add a concrete target (file, symbol, or behavior).")
  } else if (len > 300) {
    score -= 0.1
    tips.push("Split this into smaller, single-purpose instructions.")
  }

  if (VAGUE.test(text)) {
    score -= 0.25
    tips.push("Replace vague wording with a concrete, checkable request.")
  }
  if (HEDGE.test(text)) {
    score -= 0.15
    tips.push("Drop hedging; state the requirement directly.")
  }
  if (QUESTION_START.test(text.trim()) || text.trim().endsWith("?")) {
    score -= 0.2
    tips.push("Phrase it as an instruction, not a question.")
  }

  if (ACTION.test(text.trim())) score += 0.15
  if (SPECIFIC.test(text)) score += 0.2
  else tips.push("Name the exact files/symbols/values involved.")

  if (CRITERIA.test(text)) score += 0.2
  else tips.push("State the expected result or acceptance criteria.")

  const letters = text.replace(/[^A-Za-z]/g, "")
  if (letters.length > 8 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.5) {
    score -= 0.1
    tips.push("Avoid all-caps; it reads as shouting.")
  }

  score = clamp(score)
  return { text, score, level: levelFor(score), tips }
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items))
}

/** Instant heuristic analysis of a whole draft. */
export function heuristicAnalysis(text: string): Analysis {
  const segments = segmentText(text)
  if (segments.length === 0) {
    return { score: 0, level: "weak", segments: [], tips: [], tier: "heuristic" }
  }
  const scored = segments.map(scoreSegment)
  const total = scored.reduce((sum, seg) => sum + seg.text.length, 0) || 1
  const score = scored.reduce((sum, seg) => sum + seg.score * seg.text.length, 0) / total
  const tips = unique(scored.flatMap((seg) => seg.tips)).slice(0, 3)
  return { score, level: levelFor(score), segments: scored, tips, tier: "heuristic" }
}

/**
 * Merge the calibrated s1 clarity probabilities (P(clear)) with the heuristic
 * scores. The model is the stronger signal, so weight it 0.6/0.4.
 */
export function mergeAnalysis(base: Analysis, modelScores: number[]): Analysis {
  if (base.segments.length === 0) return base
  const segments = base.segments.map((seg, i) => {
    const model = typeof modelScores[i] === "number" ? clamp(modelScores[i]!) : seg.score
    const score = clamp(seg.score * 0.4 + model * 0.6)
    return { ...seg, score, level: levelFor(score) }
  })
  const total = segments.reduce((sum, seg) => sum + seg.text.length, 0) || 1
  const score = segments.reduce((sum, seg) => sum + seg.score * seg.text.length, 0) / total
  const tips = unique(segments.flatMap((seg) => seg.tips)).slice(0, 3)
  return { score, level: levelFor(score), segments, tips, tier: "s1" }
}
