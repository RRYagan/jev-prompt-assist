import { tool } from "@opencode-ai/plugin"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * jev — orchestration layer for the local Jev/System-1 classifier (s1).
 *
 * Wraps the `s1` CLI (Jevified Gemma-4-E4B, calibrated probabilities, zero
 * output tokens) with: prompt crafting, a content-hash cache, project/session
 * profiles, a system-prompt guide, and a triggered intent hint.
 *
 * Design constraints (measured): a short `noul` is ~1 s on CPU; prefill
 * dominates (~10 ms/token), so keep states short and batch questions over one
 * state (`s1 ask` shares the prefix). Hooks are awaited — everything here is
 * gated and wrapped so it can never break a turn.
 *
 * Config precedence: defaults < ~/.config/opencode/jev/config.json < env < options.
 * Toggles: JEV_INTENT=0 (intent hint), JEV_GUIDE=0 (system guide),
 * JEV_CACHE=0 (content-hash cache), JEV_PARAMS=1 (temperature routing),
 * JEV_GATE_BASE_URL / JEV_GATE_MODEL (lightweight gate endpoint).
 */

const PLUGIN_VERSION = 2
const HOME = homedir()
const STATE_DIR = join(HOME, ".config", "opencode", "jev")
const CACHE_DIR = join(HOME, ".cache", "opencode", "jev")
const SESSIONS_DIR = join(STATE_DIR, "sessions")
const GUIDE_MARKER = "[JEV PROJECT GUIDE]"
const HINT_MARK = "[jev-intent]"
const SKIP_AGENTS = new Set(["judge", "compaction", "title", "summary", "scout", "explore", "test-gen"])
// Agents whose work is deterministic enough to want a low sampling temperature
// when `chat.params` routing is enabled (JEV_PARAMS=1).
const DETERMINISTIC_AGENTS = new Set(["judge", "review", "plan", "compaction", "test-gen"])

type S1Result = {
  ok: boolean
  raw?: any
  error?: string
  cached?: boolean
  latencyMs?: number
}

type RunArgs = {
  mode: "noul" | "choice" | "score" | "ask"
  state: string
  instruction?: string
  options?: string[]
  levels?: string[]
  trueCriterion?: string
  falseCriterion?: string
  questions?: Record<string, unknown>
  threshold?: number
  fast?: boolean
  // When set, the run targets an explicit OpenAI-compatible endpoint instead of
  // the --cpu / --gpu aliases. Used for the lightweight "gate" model (e.g. a
  // small CPU classifier on :8082) so interactive hooks stay cheap.
  baseUrl?: string
  model?: string
}

// --------------------------------------------------------------------------- utils

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true })
  } catch {}
}

function readJSON<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {}
  return fallback
}

function writeJSON(path: string, value: unknown): void {
  try {
    ensureDir(dirname(path))
    writeFileSync(path, JSON.stringify(value))
  } catch {}
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function normalizeState(text: string, maxChars: number): string {
  const cleaned = stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + "\n…[truncated]" : cleaned
}

function parseOption(spec: string): [string, string | null] {
  const i = spec.indexOf("=")
  if (i === -1) return [spec.trim(), null]
  const key = spec.slice(0, i).trim()
  const desc = spec.slice(i + 1).trim()
  return [key, desc || null]
}

function cacheKey(args: RunArgs): string {
  return sha(
    JSON.stringify({
      v: PLUGIN_VERSION,
      model: process.env.S1_MODEL ?? "",
      mode: args.mode,
      state: args.state,
      instruction: args.instruction ?? "",
      options: args.options ?? [],
      levels: args.levels ?? [],
      questions: args.questions ?? null,
      threshold: args.threshold ?? null,
      baseUrl: args.baseUrl ?? "",
      model: args.model ?? "",
    }),
  )
}

// --------------------------------------------------------------------------- s1 runner

async function runS1(args: RunArgs, useCache = true): Promise<S1Result> {
  const key = cacheKey(args)
  const cachePath = join(CACHE_DIR, key + ".json")
  if (useCache) {
    const hit = readJSON<any>(cachePath, undefined as any)
    if (hit) return { ok: true, raw: hit, cached: true }
  }

  const cmd = ["s1", args.mode, "--state", "-"]
  if (args.baseUrl) {
    // Explicit endpoint (the lightweight gate model). --cpu/--gpu must NOT be
    // passed: cli.py lets them win over --base-url, so they'd ignore the gate.
    cmd.push("--base-url", args.baseUrl)
    if (args.model) cmd.push("--model", args.model)
  } else {
    cmd.push(args.fast ? "--gpu" : "--cpu")
  }
  if (args.mode === "noul") {
    if (!args.instruction) return { ok: false, error: "noul requires an instruction" }
    cmd.push("--question", args.instruction)
    if (args.trueCriterion) cmd.push("--true-criterion", args.trueCriterion)
    if (args.falseCriterion) cmd.push("--false-criterion", args.falseCriterion)
  } else if (args.mode === "choice") {
    cmd.push("--instruction", args.instruction ?? "")
    for (const option of args.options ?? []) cmd.push("--option", option)
  } else if (args.mode === "score") {
    cmd.push("--instruction", args.instruction ?? "")
    for (const level of args.levels ?? []) cmd.push("--level", level)
  } else {
    cmd.push("--questions", JSON.stringify(args.questions ?? {}))
  }
  if (args.threshold !== undefined) cmd.push("--threshold", String(args.threshold))

  const started = Date.now()
  try {
    const proc = Bun.spawn(cmd, {
      stdin: new TextEncoder().encode(args.state),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    const trimmed = stdout.trim()
    if (!trimmed) {
      return { ok: false, error: stderr.trim() || `s1 exited ${code} with no output` }
    }
    let raw: any
    try {
      raw = JSON.parse(trimmed)
    } catch {
      return { ok: false, error: trimmed || stderr.trim() }
    }
    if (useCache) writeJSON(cachePath, raw)
    return { ok: true, raw, latencyMs: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// --------------------------------------------------------------------------- verification

// Order-sensitivity / self-consistency gate. Re-run the same judgment with the
// answer space reversed and compare. A flip means the model is position-biased
// and the decision should be treated as `review` rather than acted on.
async function consistencyCheck(
  crafted: Crafted,
  state: string,
  base: RunArgs,
  useCache: boolean,
): Promise<string | undefined> {
  try {
    if (crafted.mode === "choice" && crafted.options && crafted.options.length >= 2) {
      const forward = await runS1({ ...base, state, mode: "choice", options: crafted.options }, useCache)
      const reversed = await runS1({ ...base, state, mode: "choice", options: [...crafted.options].reverse() }, useCache)
      const f = forward.raw?.result?.choice
      const r = reversed.raw?.result?.choice
      if (typeof f !== "string" || typeof r !== "string") return undefined
      return f === r
        ? `verify: consistent (forward=${f}, reversed=${r}) → trust`
        : `verify: order-sensitive (forward=${f}, reversed=${r}) → treat as review`
    }
    if (crafted.mode === "score" && crafted.levels && crafted.levels.length >= 2) {
      const n = crafted.levels.length
      const reversedLevels = [...crafted.levels].reverse()
      const forward = await runS1({ ...base, state, mode: "score", levels: crafted.levels }, useCache)
      const reversed = await runS1({ ...base, state, mode: "score", levels: reversedLevels }, useCache)
      const f = forward.raw?.result?.score
      const r = reversed.raw?.result?.score
      if (typeof f !== "number" || typeof r !== "number") return undefined
      // score is the 0-based expected index, so a reversed level list must
      // mirror it: score_fwd + score_rev ≈ n - 1.
      const gap = Math.abs(f + r - (n - 1))
      const fLabel = crafted.levels[Math.round(f)] ?? "?"
      const rLabel = reversedLevels[Math.round(r)] ?? "?"
      return gap <= 0.75
        ? `verify: consistent (forward=${fLabel}, reversed=${rLabel}) → trust`
        : `verify: order-sensitive (forward=${fLabel}, reversed=${rLabel}) → treat as review`
    }
  } catch {}
  return undefined
}

function recentDecisions(sessionID: string | undefined, limit = 5): string[] {
  if (!sessionID) return []
  const list = readJSON<any[]>(join(SESSIONS_DIR, `${sessionID}.json`), [])
  return list.slice(-limit).map((entry) => {
    const answer = JSON.stringify(entry.answer ?? {}).slice(0, 120)
    return `- ${entry.mode}: ${String(entry.instructions ?? "").slice(0, 90)} → ${answer}`
  })
}

// --------------------------------------------------------------------------- crafting

type Crafted = {
  mode: "noul" | "choice" | "score"
  instructions: string
  criteria?: Record<string, string | null> | string[]
  options?: string[]
  levels?: string[]
  trueCriterion?: string
  falseCriterion?: string
  notes: string[]
}

function craft(
  task: string,
  kind: "auto" | "noul" | "choice" | "score",
  options: string[] | undefined,
  levels: string[] | undefined,
  trueCriterion: string | undefined,
  falseCriterion: string | undefined,
): Crafted {
  const notes: string[] = []
  let mode: "noul" | "choice" | "score" = kind === "auto" ? "noul" : kind
  if (kind === "auto") {
    if (options && options.length) mode = "choice"
    else if (levels && levels.length) mode = "score"
  }

  const instructions = task.trim() || "Decide whether the described condition holds."
  const crafted: Crafted = { mode, instructions, notes }

  if (mode === "choice") {
    const parsed = (options ?? []).map(parseOption)
    crafted.criteria = Object.fromEntries(parsed)
    crafted.options = parsed.map(([key]) => key)
    if (parsed.length < 2) notes.push("choice needs at least 2 options — add more.")
    if (parsed.length > 5) notes.push("More than ~5 options lowers calibration; consider splitting.")
    if (parsed.some(([, desc]) => !desc))
      notes.push("Add a short description to each option (key=description); descriptions carry the signal.")
  } else if (mode === "score") {
    const list = levels ?? []
    crafted.criteria = list
    crafted.levels = list
    if (list.length < 2) notes.push("score needs at least 2 ordered levels (low → high).")
    if (list.length > 5) notes.push("More than ~5 levels lowers calibration.")
  } else {
    crafted.trueCriterion = trueCriterion
    crafted.falseCriterion = falseCriterion
    if (!trueCriterion && !falseCriterion)
      notes.push("Define the boundary with trueCriterion/falseCriterion — the biggest accuracy lever for yes/no.")
    if (!/\?\s*$/.test(instructions) && !/\b(is|does|did|has|can|should|are|will)\b/i.test(instructions))
      notes.push("Phrase the noul as a plain yes/no statement, e.g. 'This diff changes runtime behavior.'")
  }

  if (estimateTokens(instructions) > 60)
    notes.push("Instructions are long; move detail into the state to keep the question crisp.")
  return crafted
}

function renderCrafted(crafted: Crafted, state: string, fast: boolean): string[] {
  const lines: string[] = []
  lines.push(`JEV PROMPT — ${crafted.mode} (${fast ? "gpu" : "cpu"})`)
  lines.push(`state (~${estimateTokens(state)} tok):`)
  lines.push(state.length > 1200 ? state.slice(0, 1200) + "\n…" : state)
  lines.push("")
  lines.push(`instructions: ${crafted.instructions}`)
  if (crafted.mode === "choice" && crafted.criteria) {
    lines.push("criteria:")
    for (const [key, desc] of Object.entries(crafted.criteria as Record<string, string | null>)) {
      lines.push(`  ${key}${desc ? " — " + desc : ""}`)
    }
  } else if (crafted.mode === "score" && crafted.criteria) {
    lines.push("levels (low → high):")
    for (const level of crafted.criteria as string[]) lines.push(`  ${level}`)
  } else if (crafted.trueCriterion || crafted.falseCriterion) {
    lines.push("criteria:")
    if (crafted.trueCriterion) lines.push(`  true — ${crafted.trueCriterion}`)
    if (crafted.falseCriterion) lines.push(`  false — ${crafted.falseCriterion}`)
  }
  if (crafted.notes.length) {
    lines.push("")
    lines.push("notes:")
    for (const note of crafted.notes) lines.push(`  - ${note}`)
  }
  return lines
}

// --------------------------------------------------------------------------- profiles

function loadGuide(directory: string): string | undefined {
  const project = readJSON<any>(join(directory, ".opencode", "jev.json"), undefined as any)
  if (project && typeof project.guide === "string" && project.guide.trim()) return project.guide.trim()
  const global = join(STATE_DIR, "guide.md")
  try {
    if (existsSync(global)) {
      const text = readFileSync(global, "utf8").trim()
      if (text) return text
    }
  } catch {}
  return undefined
}

function record(sessionID: string | undefined, entry: Record<string, unknown>): void {
  if (!sessionID) return
  const path = join(SESSIONS_DIR, `${sessionID}.json`)
  const list = readJSON<any[]>(path, [])
  list.push({ ts: Date.now(), ...entry })
  if (list.length > 60) list.splice(0, list.length - 60)
  writeJSON(path, list)
}

// --------------------------------------------------------------------------- intent hint

const VAGUE_RE = /\b(it|this|that|thing|stuff|something|somehow|whatever|etc)\b/i
const ACTION_RE = /\b(fix|improve|clean\s?up|refactor|update|change|optimi[sz]e|make .* better)\b/i

function isVague(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 6 || trimmed.length > 400) return false
  if (trimmed.startsWith("/")) return false
  if (trimmed.length < 90 && VAGUE_RE.test(trimmed)) return true
  if (trimmed.length < 60 && ACTION_RE.test(trimmed) && !/[./\\`]/.test(trimmed)) return true
  return false
}

function lastTextPart(parts: any[]): any | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part && part.type === "text" && typeof part.text === "string") return part
  }
  return undefined
}

const HINT_COOLDOWN_MS = 20_000
const lastHintAt = new Map<string, number>()

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

// --------------------------------------------------------------------------- plugin

const plugin: Plugin = async ({ directory }, options?: PluginOptions) => {
  // Config precedence: defaults < ~/.config/opencode/jev/config.json < env < options.
  // The file matters because a plugin auto-loaded from the plugins directory never
  // receives `plugin[]` options.
  const fileConfig = readJSON<Record<string, unknown>>(join(STATE_DIR, "config.json")) ?? {}
  const envBool = (name: string, fallback: boolean) =>
    process.env[name] === undefined ? fallback : process.env[name] !== "0"
  const fileBool = (name: string, fallback: boolean) =>
    typeof fileConfig[name] === "boolean" ? (fileConfig[name] as boolean) : fallback
  const config = {
    fast: envBool("JEV_FAST", fileBool("fast", false)),
    intentHint: envBool("JEV_INTENT", fileBool("intentHint", true)),
    guide: envBool("JEV_GUIDE", fileBool("guide", true)),
    cache: envBool("JEV_CACHE", fileBool("cache", true)),
    maxStateChars: typeof fileConfig.maxStateChars === "number" ? fileConfig.maxStateChars : 4000,
    // Lightweight "gate" endpoint for cheap interactive judgments. When unset,
    // interactive hooks fall back to the resident CPU server (--cpu).
    gateBaseUrl:
      process.env.JEV_GATE_BASE_URL ??
      (typeof fileConfig.gateBaseUrl === "string" ? fileConfig.gateBaseUrl : ""),
    gateModel:
      process.env.JEV_GATE_MODEL ??
      (typeof fileConfig.gateModel === "string" ? fileConfig.gateModel : ""),
  }
  if (options) {
    if (typeof options.fast === "boolean") config.fast = options.fast
    if (typeof options.intentHint === "boolean") config.intentHint = options.intentHint
    if (typeof options.guide === "boolean") config.guide = options.guide
    if (typeof options.cache === "boolean") config.cache = options.cache
    if (typeof options.maxStateChars === "number") config.maxStateChars = options.maxStateChars
    if (typeof options.gateBaseUrl === "string") config.gateBaseUrl = options.gateBaseUrl
    if (typeof options.gateModel === "string") config.gateModel = options.gateModel
  }

  // Backend selection for a run. `gate` targets the lightweight endpoint when
  // configured; otherwise it degrades to the normal cpu/gpu route.
  const backend = (useGate: boolean): Pick<RunArgs, "fast" | "baseUrl" | "model"> => {
    if (useGate && config.gateBaseUrl) return { baseUrl: config.gateBaseUrl, model: config.gateModel || undefined }
    return { fast: config.fast }
  }

  const jevPrompt = tool({
    description:
      "Craft an optimal Jev/System-1 classifier prompt from a rough request, then " +
      "optionally run it on the local s1 model (calibrated probabilities, CPU, zero " +
      "output tokens). Use for routing, triage, risk scoring, and yes/no decisions. " +
      "Returns the crafted prompt, guidance notes, and (with run=true) the calibrated " +
      "result. Set run=true to execute; keep states short (<~150 tokens) for speed.",
    args: {
      task: tool.schema.string().describe("What you want to decide or know, in plain language"),
      state: tool.schema.string().describe("The artifact to judge (diff, log, ticket, JSON, prose)"),
      kind: tool.schema
        .enum(["auto", "noul", "choice", "score"])
        .default("auto")
        .describe("auto picks choice if options given, score if levels given, else noul"),
      options: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("For choice: 'key' or 'key=description' (2–5 recommended)"),
      levels: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("For score: ordered levels low → high (2–5 recommended)"),
      trueCriterion: tool.schema.string().optional().describe("For noul: what a yes means"),
      falseCriterion: tool.schema.string().optional().describe("For noul: what a no means"),
      threshold: tool.schema.number().optional().describe("Confidence gate (0.85 recommended)"),
      verify: tool.schema
        .boolean()
        .default(false)
        .describe("Self-consistency gate: re-run with the answer space reversed and flag order-sensitive results (choice/score; ~2x latency)"),
      gate: tool.schema
        .boolean()
        .default(false)
        .describe("Run on the lightweight gate endpoint (JEV_GATE_BASE_URL) when configured, else the normal CPU route"),
      run: tool.schema.boolean().default(false).describe("Execute the crafted prompt with s1"),
      save: tool.schema.boolean().default(true).describe("Record the decision in the session ledger"),
    },
    async execute(args, ctx) {
      const state = normalizeState(args.state ?? "", config.maxStateChars)
      const crafted = craft(args.task, args.kind, args.options, args.levels, args.trueCriterion, args.falseCriterion)
      const lines = renderCrafted(crafted, state, config.fast)

      if (!args.run) {
        lines.push("")
        lines.push("(dry run — pass run: true to execute with s1)")
        return lines.join("\n")
      }

      const runArgs: RunArgs = {
        mode: crafted.mode,
        state,
        instruction: crafted.instructions,
        options: crafted.options,
        levels: crafted.levels,
        trueCriterion: crafted.trueCriterion,
        falseCriterion: crafted.falseCriterion,
        threshold: args.threshold,
        ...backend(args.gate),
      }
      const result = await runS1(runArgs, config.cache)

      lines.push("")
      if (result.ok) {
        const payload = result.raw?.result ?? result.raw?.answers ?? result.raw
        lines.push(`result${result.cached ? " (cached)" : ""}: ${JSON.stringify(payload)}`)
        if (result.raw?.latency_ms !== undefined) lines.push(`latency_ms: ${result.raw.latency_ms}`)
        if (result.raw?.action) lines.push(`action: ${result.raw.action}`)
        if (args.verify) {
          const check = await consistencyCheck(crafted, state, runArgs, config.cache)
          if (check) lines.push(check)
        }
        if (args.save !== false) {
          record(ctx.sessionID, {
            mode: crafted.mode,
            instructions: crafted.instructions,
            answer: result.raw?.result ?? result.raw?.answers,
          })
        }
      } else {
        lines.push(`s1 error: ${result.error}`)
      }
      return lines.join("\n")
    },
  })

  return {
    tool: { jev_prompt: jevPrompt },

    // Inject the project's classification guide into the system prompt (opt-in
    // via .opencode/jev.json or the global ~/.config/opencode/jev/guide.md).
    "experimental.chat.system.transform": async (_input, output) => {
      if (!config.guide) return
      try {
        const guide = loadGuide(directory)
        if (!guide) return
        if (output.system.join("\n").includes(GUIDE_MARKER)) return
        const block =
          `\n\n${GUIDE_MARKER}\n${guide}\n` +
          "When a decision needs a calibrated probability, prefer the `jev_prompt` tool " +
          "(or the @judge subagent) over guessing."
        if (output.system.length) output.system[output.system.length - 1] += block
        else output.system.push(block)
      } catch {}
    },

    // Cheap vague-prompt detection, then one batched s1 call over the turn.
    // Gated + debounced so it does not add ~1 s to every message.
    "chat.message": async (input, output) => {
      if (!config.intentHint) return
      try {
        if (input.agent && SKIP_AGENTS.has(input.agent)) return
        const part = lastTextPart(output.parts as any[])
        if (!part || part.text.includes(HINT_MARK)) return
        if (!isVague(part.text)) return
        const now = Date.now()
        const last = lastHintAt.get(input.sessionID) ?? 0
        if (now - last < HINT_COOLDOWN_MS) return

        const result = await runS1(
          {
            mode: "ask",
            state: normalizeState(part.text, 1500),
            questions: INTENT_QUESTIONS,
            ...backend(true),
          },
          config.cache,
        )
        if (!result.ok || !result.raw?.answers) return
        lastHintAt.set(input.sessionID, now)

        const answers = result.raw.answers as any
        const kindAns = answers.kind
        const kind = typeof kindAns?.choice === "string" ? kindAns.choice : undefined
        const confidence = typeof kindAns?.confidence === "number" ? kindAns.confidence : undefined
        const vagueP = typeof answers.vague?.noul === "number" ? answers.vague.noul : undefined
        if (!kind && vagueP === undefined) return
        if (kind && (confidence ?? 0) < 0.5 && !(vagueP !== undefined && vagueP >= 0.6)) return

        const kindText = kind ?? "unknown"
        const confText = confidence !== undefined ? ` (conf ${confidence.toFixed(2)})` : ""
        const vagueText =
          vagueP !== undefined && vagueP >= 0.6
            ? "looks under-specified — pin the exact target and acceptance criteria before acting"
            : "actionable as written"
        part.text = part.text.trimEnd() + `\n\n${HINT_MARK} classified: ${kindText}${confText}; ${vagueText}.`
      } catch {}
    },

    // Carry the project guide and recent calibrated decisions through
    // compaction, so a long session keeps its classification context.
    "experimental.session.compacting": async (input, output) => {
      try {
        const blocks: string[] = []
        const guide = config.guide ? loadGuide(directory) : undefined
        if (guide) blocks.push(`${GUIDE_MARKER}\n${guide}`)
        const recent = recentDecisions(input.sessionID)
        if (recent.length) blocks.push("Jev decisions this session (keep if still relevant):\n" + recent.join("\n"))
        if (blocks.length) output.context.push(blocks.join("\n\n"))
      } catch {}
    },

    // Optional deterministic sampling for classification-style agents. Off
    // unless JEV_PARAMS=1, so it never surprises the default setup.
    "chat.params": async (input, output) => {
      if (process.env.JEV_PARAMS !== "1") return
      try {
        if (input.agent && DETERMINISTIC_AGENTS.has(input.agent)) {
          output.temperature = Math.min(output.temperature ?? 0.2, 0.2)
        }
      } catch {}
    },
  }
}

export default plugin
