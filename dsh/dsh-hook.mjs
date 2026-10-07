#!/usr/bin/env node
/**
 * dsh Jev bridge hook.
 *
 * Runs as a Claude-Code-style command hook under the dsh `dsh-hooks-claude-code`
 * bridge. It classifies the incoming prompt with the local Jev/System-1 model
 * (`s1`) and returns an `additionalContext` message the harness folds into the
 * turn. Fail-open by design: on any error it emits nothing and exits 0, so it
 * can never break a session.
 *
 * Supported events:
 *   SessionStart      -> inject a System-1 primer + the project's classification guide
 *   UserPromptSubmit  -> one batched `s1 ask` (task kind + under-specified) on vague prompts
 *
 * Rules for this hook:
 *   - The bridge only reads `hookSpecificOutput.additionalContext`; top-level
 *     `additionalContext` is ignored.
 *   - A missing/different `hookEventName` discards the context, so it is exact.
 *   - Keep the model call off the hot path: gate on a cheap heuristic and a
 *     per-session cooldown, so most prompts cost nothing.
 *
 * Env:
 *   S1_BIN              path to the s1 CLI (default ~/.local/bin/s1)
 *   JEV_GATE_BASE_URL   optional lightweight endpoint (e.g. http://127.0.0.1:8082/v1)
 *   JEV_GATE_MODEL      optional model name for that endpoint
 *   JEV_DSH=0           disable the bridge entirely
 */

import { readFileSync, existsSync, statSync, utimesSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { tmpdir } from "node:os"

const HINT_MARK = "[jev-intent]"
const GUIDE_MARKER = "[JEV PROJECT GUIDE]"
const COOLDOWN_MS = 20_000
const S1_BIN = process.env.S1_BIN || join(homedir(), ".local", "bin", "s1")

const VAGUE_RE = /\b(it|this|that|thing|stuff|something|somehow|whatever|etc)\b/i
const ACTION_RE = /\b(fix|improve|clean\s?up|refactor|update|change|optimi[sz]e|make .* better)\b/i

const INTENT_QUESTIONS = {
  kind: {
    type: "choice",
    instructions: "What kind of work does this request ask for?",
    criteria: {
      "code-change": "Add, modify, or remove code behavior",
      debug: "Diagnose or fix a failure, error, or crash",
      research: "Find, read, explain, or compare information",
      config: "Change config, environment, deps, or tooling",
      question: "Answer a question with no repository change",
      other: "None of the above",
    },
  },
  vague: {
    type: "noul",
    instructions:
      "Would a senior engineer need at least one clarifying question before starting, or is the request actionable as written?",
    criteria: {
      true: "The request omits the target, scope, or acceptance criteria needed to start",
      false: "The request names a concrete target and a clear outcome",
    },
  },
}

function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function emit(eventName, text) {
  if (!text) return
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }),
  )
}

function isVague(text) {
  const trimmed = String(text || "").trim()
  if (trimmed.length < 6 || trimmed.length > 400) return false
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return false
  if (trimmed.length < 90 && VAGUE_RE.test(trimmed)) return true
  if (trimmed.length < 60 && ACTION_RE.test(trimmed) && !/[./\\`]/.test(trimmed)) return true
  return false
}

function cooldownOk(sessionID) {
  try {
    const stamp = join(tmpdir(), `.jev-dsh-${String(sessionID || "anon").slice(0, 64)}`)
    const now = Date.now()
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < COOLDOWN_MS) return false
    utimesSync(stamp, new Date(), new Date())
    return true
  } catch {
    return true
  }
}

function s1(modeArgs, state) {
  const route = process.env.JEV_GATE_BASE_URL
    ? ["--base-url", process.env.JEV_GATE_BASE_URL, ...(process.env.JEV_GATE_MODEL ? ["--model", process.env.JEV_GATE_MODEL] : [])]
    : process.env.JEV_GPU === "1"
      ? ["--gpu"]
      : ["--cpu"]
  const args = [modeArgs[0], ...route, "--state", "-", ...modeArgs.slice(1)]
  const res = spawnSync(S1_BIN, args, {
    input: String(state || ""),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1 << 20,
  })
  if (!res || !res.stdout) return null
  try {
    return JSON.parse(res.stdout)
  } catch {
    return null
  }
}

function loadGuide(cwd) {
  try {
    const project = join(cwd || ".", ".opencode", "jev.json")
    if (existsSync(project)) {
      const parsed = JSON.parse(readFileSync(project, "utf8"))
      if (parsed && typeof parsed.guide === "string" && parsed.guide.trim()) return parsed.guide.trim()
    }
  } catch {}
  try {
    const global = join(homedir(), ".config", "opencode", "jev", "guide.md")
    if (existsSync(global)) {
      const text = readFileSync(global, "utf8").trim()
      if (text) return text
    }
  } catch {}
  return ""
}

function onSessionStart(payload) {
  const parts = [
    "A local calibrated classifier is available through the `s1` CLI (noul = P(yes), choice, score; zero paid tokens, no output tokens). Use it for routing, triage, risk, and yes/no decisions instead of guessing.",
  ]
  const guide = loadGuide(payload.cwd)
  if (guide) parts.push(`${GUIDE_MARKER}\n${guide}`)
  emit("SessionStart", parts.join("\n\n"))
}

function onUserPromptSubmit(payload) {
  const prompt = payload.prompt || payload.user_prompt || ""
  if (!isVague(prompt)) return
  if (!cooldownOk(payload.session_id)) return
  const out = s1(["ask", "--questions", JSON.stringify(INTENT_QUESTIONS)], String(prompt).slice(0, 1500))
  const answers = out && out.answers
  if (!answers) return
  const kind = answers.kind && typeof answers.kind.choice === "string" ? answers.kind.choice : undefined
  const confidence = answers.kind && typeof answers.kind.confidence === "number" ? answers.kind.confidence : undefined
  const vagueP = answers.vague && typeof answers.vague.noul === "number" ? answers.vague.noul : undefined
  if (!kind && vagueP === undefined) return
  if (kind && (confidence ?? 0) < 0.5 && !(vagueP !== undefined && vagueP >= 0.6)) return

  const confText = confidence !== undefined ? ` (conf ${confidence.toFixed(2)})` : ""
  const vagueText =
    vagueP !== undefined && vagueP >= 0.6
      ? "looks under-specified — pin the exact target and acceptance criteria before acting"
      : "actionable as written"
  emit("UserPromptSubmit", `${HINT_MARK} classified: ${kind ?? "unknown"}${confText}; ${vagueText}.`)
}

function main() {
  if (process.env.JEV_DSH === "0") return
  let payload
  try {
    payload = JSON.parse(readStdin() || "{}")
  } catch {
    return
  }
  try {
    const event = payload.hook_event_name
    if (event === "SessionStart") onSessionStart(payload)
    else if (event === "UserPromptSubmit") onUserPromptSubmit(payload)
  } catch {}
}

main()
