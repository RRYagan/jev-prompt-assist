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
  /** Enable project-context autosuggest (symbol/file hints). */
  suggest: boolean
  /** Minimum fragment length before suggestions appear. */
  suggestMinChars: number
  /** Maximum number of autosuggest candidates to show. */
  suggestLimit: number
  /** Which sources to use: the idx lexicon, the server find API, or both. */
  suggestSources: "idx" | "server" | "both"
  /** Suggest file paths as `@mentions`. */
  mention: boolean
  /** Quiet period before the async server lookup runs. */
  suggestDebounceMs: number
  /** Key that accepts the selected suggestion (empty string disables). */
  acceptKey: string
  /** Key that selects the next suggestion. */
  suggestNextKey: string
  /** Key that selects the previous suggestion. */
  suggestPrevKey: string
  /** Enable the ASD-STE100 style checker (findings in the suggestion list). */
  style: boolean
  /** Style profile; only "ste" is implemented. */
  styleProfile: "ste"
  /** Override path to the STE dictionary JSON (default: config dir). */
  steDictionary: string
  /** Override path to a glossary file (default: config dir glossary.txt). */
  glossary: string
  /** Maximum words in a procedural (instruction) sentence. */
  steMaxInstructionWords: number
  /** Maximum words in a descriptive sentence. */
  steMaxDescriptiveWords: number
  /** Also flag words absent from the dictionary (Rules 1.5/1.12; noisy). */
  steFlagUnknown: boolean
  /** Maximum style findings to show. */
  styleLimit: number
  /** Enable the safe general-grammar tier. */
  grammar: boolean
  /** Maximum grammar findings to show. */
  grammarLimit: number
  /** Search the idx content index for the files/functions a draft talks about. */
  context: boolean
  /** Minimum draft length before a content search runs. */
  contextMinChars: number
  /** Maximum content hits to surface. */
  contextLimit: number
  /** Quiet period before the content search runs. */
  contextDebounceMs: number
  /** Where content suggestions may appear even without a typed fragment. */
  contextSources: "auto" | "always" | "off"
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
    suggestMinChars: num(live.suggestMinChars, 2),
    suggestLimit: num(live.suggestLimit, 5),
    suggestSources:
      live.suggestSources === "idx" || live.suggestSources === "server"
        ? live.suggestSources
        : "both",
    mention: envBool("JEV_MENTION", bool(live.mention, true)),
    suggestDebounceMs: num(live.suggestDebounceMs, 250),
    acceptKey: typeof live.acceptKey === "string" ? live.acceptKey : "alt+s",
    suggestNextKey: typeof live.suggestNextKey === "string" ? live.suggestNextKey : "alt+n",
    suggestPrevKey: typeof live.suggestPrevKey === "string" ? live.suggestPrevKey : "alt+p",
    style: envBool("JEV_STYLE", bool(live.style, true)),
    styleProfile: "ste",
    steDictionary:
      process.env.JEV_STE_DICT ??
      (typeof live.steDictionary === "string" ? live.steDictionary : ""),
    glossary:
      process.env.JEV_GLOSSARY ?? (typeof live.glossary === "string" ? live.glossary : ""),
    steMaxInstructionWords: num(live.steMaxInstructionWords, 20),
    steMaxDescriptiveWords: num(live.steMaxDescriptiveWords, 25),
    steFlagUnknown: envBool("JEV_STE_UNKNOWN", bool(live.steFlagUnknown, false)),
    styleLimit: num(live.styleLimit, 6),
    grammar: envBool("JEV_GRAMMAR", bool(live.grammar, true)),
    grammarLimit: num(live.grammarLimit, 6),
    context: envBool("JEV_CONTEXT", bool(live.context, true)),
    contextMinChars: num(live.contextMinChars, 10),
    contextLimit: num(live.contextLimit, 4),
    contextDebounceMs: num(live.contextDebounceMs, 400),
    contextSources:
      live.contextSources === "always" || live.contextSources === "off" ? live.contextSources : "auto",
    gateBaseUrl:
      process.env.JEV_GATE_BASE_URL ??
      (typeof raw.gateBaseUrl === "string" ? raw.gateBaseUrl : "http://127.0.0.1:8082/v1"),
    gateModel:
      process.env.JEV_GATE_MODEL ??
      (typeof raw.gateModel === "string" ? raw.gateModel : "jevify-gemma4-e4b"),
  }
}
