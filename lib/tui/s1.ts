// Tier-2 classification: one batched `s1 ask` over all segments (single
// prefill), content-hash cached. Returns P(clear) per segment, or null when
// the classifier is unavailable. Never throws.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE_DIR = join(homedir(), ".cache", "opencode", "jev", "live")
const VERSION = 1

type S1Payload = { answers?: Record<string, { noul?: number }> }

function pick(payload: S1Payload | null, count: number): number[] | null {
  if (!payload || typeof payload !== "object") return null
  const answers = payload.answers
  if (!answers || typeof answers !== "object") return null
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const answer = answers[`s${i}`]
    if (!answer || typeof answer.noul !== "number") return null
    out.push(answer.noul)
  }
  return out
}

function readCache(file: string): number[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(parsed?.scores) ? (parsed.scores as number[]) : null
  } catch {
    return null
  }
}

function writeCache(file: string, scores: number[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify({ scores, at: Date.now() }))
  } catch {
    /* cache is best-effort */
  }
}

function run(cmd: string[], stdin: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: process.env })
    let out = ""
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      finish(null)
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => {
      out += String(chunk)
    })
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code === 0 ? out : null))
    try {
      child.stdin?.write(stdin)
      child.stdin?.end()
    } catch {
      /* ignore */
    }
  })
}

export type S1Options = { baseUrl: string; model: string; timeoutMs?: number }

export async function scoreWithS1(segments: string[], opts: S1Options): Promise<number[] | null> {
  if (segments.length === 0) return []
  const state = JSON.stringify({ sentences: segments.map((text, i) => ({ i: i + 1, text })) })
  const questions: Record<string, unknown> = {}
  segments.forEach((_, i) => {
    questions[`s${i}`] = {
      type: "noul",
      instructions: `Is sentence ${i + 1} a clear, specific, actionable instruction for an AI coding agent?`,
      criteria: {
        true: "Names a concrete target (file, symbol, value, or behavior) and makes the expected result clear; actionable as written.",
        false: "Vague, ambiguous, or missing the target and/or the expected result.",
      },
    }
  })

  const key = createHash("sha256")
    .update(JSON.stringify({ v: VERSION, state, questions, baseUrl: opts.baseUrl, model: opts.model }))
    .digest("hex")
  const file = join(CACHE_DIR, `${key}.json`)
  const cached = readCache(file)
  if (cached) return cached

  // Same binary the server plugin uses (JEV_S1_BIN), with S1_BIN kept as the
  // older alias for anyone who already set it.
  const s1 = process.env.JEV_S1_BIN ?? process.env.S1_BIN ?? "s1"
  const cmd = [
    s1,
    "ask",
    "--state",
    "-",
    "--questions",
    JSON.stringify(questions),
    "--base-url",
    opts.baseUrl,
    "--model",
    opts.model,
  ]
  // Prefill dominates and the questions are batched over one state prefix:
  // budget grows with the number of sentences scored (measured ~3.3 s per
  // noul question on the CPU gate under load).
  const budget = opts.timeoutMs ?? Math.min(90_000, 20_000 + 4_000 * segments.length)
  const stdout = await run(cmd, state, budget)
  if (!stdout) return null

  let parsed: S1Payload | null = null
  try {
    parsed = JSON.parse(stdout) as S1Payload
  } catch {
    return null
  }
  const scores = pick(parsed, segments.length)
  if (scores) writeCache(file, scores)
  return scores
}
