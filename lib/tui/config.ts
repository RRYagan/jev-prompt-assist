// Live prompt-clarity panel configuration.
//
// Reads the shared plugin config (~/.config/opencode/jev/config.json) and an
// optional `live` section. This must never throw: an unreadable/missing file
// simply yields defaults so the TUI never breaks.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type LiveConfig = {
  /** Master switch for the live panel. */
  enabled: boolean
  /** Quiet period after the last keystroke before the s1 pass runs. */
  debounceMs: number
  /** How often to poll the prompt ref for new text. */
  pollMs: number
  /** Do not call the model below this input length. */
  minChars: number
  /** Do not call the model above this input length (prefill cost). */
  maxChars: number
  /** Enable the debounced s1 tier (tier 2) on top of instant heuristics. */
  useModel: boolean
  /** Enable project-context autosuggest (symbol/file hints) from the idx index. */
  suggest: boolean
  /** Maximum number of autosuggest candidates to show. */
  suggestLimit: number
  /** Key that accepts the top suggestion (empty string disables the binding). */
  acceptKey: string
  /** OpenAI-compatible endpoint for the classifier. */
  gateBaseUrl: string
  /** Model alias served at gateBaseUrl. */
  gateModel: string
}

const CONFIG_PATH = () => join(homedir(), ".config", "opencode", "jev", "config.json")

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

export function loadLiveConfig(): LiveConfig {
  let raw: Record<string, unknown> = {}
  try {
    const text = readFileSync(CONFIG_PATH(), "utf8")
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>
  } catch {
    raw = {}
  }
  const live = (raw.live && typeof raw.live === "object" ? raw.live : {}) as Record<string, unknown>
  const envBool = (name: string, fallback: boolean) =>
    process.env[name] === undefined ? fallback : process.env[name] !== "0"

  return {
    enabled: envBool("JEV_LIVE", bool(live.enabled, true)),
    debounceMs: num(live.debounceMs, 700),
    pollMs: num(live.pollMs, 150),
    minChars: num(live.minChars, 12),
    maxChars: num(live.maxChars, 800),
    useModel: bool(live.model, true),
    suggest: envBool("JEV_SUGGEST", bool(live.suggest, true)),
    suggestLimit: num(live.suggestLimit, 5),
    acceptKey: typeof live.acceptKey === "string" ? live.acceptKey : "ctrl+shift+s",
    gateBaseUrl:
      process.env.JEV_GATE_BASE_URL ??
      (typeof raw.gateBaseUrl === "string" ? raw.gateBaseUrl : "http://127.0.0.1:8082/v1"),
    gateModel:
      process.env.JEV_GATE_MODEL ??
      (typeof raw.gateModel === "string" ? raw.gateModel : "jevify-gemma4-e4b"),
  }
}
