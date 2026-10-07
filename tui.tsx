/** @jsxImportSource @opentui/solid */
// jev-prompt-assist — TUI half.
//
// Renders the prompt with a live annotation panel directly beneath it:
//   • Tier 1 (instant, no model): local heuristics score + per-sentence colours
//   • Tier 2 (debounced): a batched `s1 ask` pass refines the score
//
// The panel is terminal-TUI only. The opencode desktop/web apps do not load
// @opentui slot plugins; see README/PLAN.
import type { TuiPluginModule, TuiPromptRef, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { ErrorBoundary, createSignal, onCleanup } from "solid-js"
import { loadLiveConfig, type LiveConfig } from "./lib/tui/config"
import { heuristicAnalysis, mergeAnalysis, type Analysis } from "./lib/tui/analyze"
import { scoreWithS1 } from "./lib/tui/s1"
import { loadLexicon } from "./lib/tui/lexicon"
import { currentFragment, suggestFor } from "./lib/tui/suggest"
import { LivePanel } from "./lib/tui/panel"

type TuiApi = Parameters<TuiPluginModule["tui"]>[0]

// The analysis signal is never undefined: an empty draft yields this neutral
// value, so the panel's render path has no null dereferences (the old
// `state()!.tips` crash).
const EMPTY: Analysis = { score: 0, level: "weak", segments: [], tips: [], tier: "heuristic" }

// State shared between the rendered prompt and the global keymap layer (the
// accept-suggestion binding runs outside the component, so it needs the live
// ref and the latest candidates).
type Shared = {
  ref?: TuiPromptRef
  fragment: string
  suggestions: string[]
}

function applySuggestion(shared: Shared): void {
  try {
    const ref = shared.ref
    const top = shared.suggestions[0]
    const fragment = shared.fragment
    if (!ref || !top || !fragment) return
    const current = ref.current
    const input = current?.input ?? ""
    if (!input.endsWith(fragment)) return
    const next = input.slice(0, input.length - fragment.length) + top
    ref.set({ input: next, parts: current?.parts ?? [] })
    ref.focus()
  } catch {
    // never let the accept binding throw into the TUI
  }
}

const DEBUG = process.env.JEV_TUI_DEBUG === "1"
const SELFTEST = process.env.JEV_TUI_SELFTEST === "1"

function debugLog(message: string) {
  if (!DEBUG) return
  try {
    process.stderr.write(`[jev-tui] ${message}\n`)
  } catch {
    // diagnostic only
  }
}

interface PanelProps {
  api: TuiApi
  cfg: LiveConfig
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  hostRef?: (ref: TuiPromptRef | undefined) => void
  shared?: Shared
}

function PromptWithPanel(props: PanelProps) {
  const [analysis, setAnalysis] = createSignal<Analysis>(EMPTY)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [suggestions, setSuggestions] = createSignal<string[]>([])

  let ref: TuiPromptRef | undefined
  let lastInput = ""
  let generation = 0
  let debounce: ReturnType<typeof setTimeout> | undefined

  const onRef = (value: TuiPromptRef | undefined) => {
    ref = value
    if (props.shared) props.shared.ref = value
    try {
      props.hostRef?.(value)
    } catch {
      // never let a host-ref error break the prompt
    }
  }

  const runModel = (base: Analysis, gen: number) => {
    setBusy(true)
    setError(undefined)
    scoreWithS1(
      base.segments.map((segment) => segment.text),
      { baseUrl: props.cfg.gateBaseUrl, model: props.cfg.gateModel },
    )
      .then((scores) => {
        if (gen !== generation) return
        if (scores && scores.length === base.segments.length) {
          setAnalysis(mergeAnalysis(base, scores))
        } else if (!scores) {
          setError("model unavailable — instant score only")
        }
        setBusy(false)
      })
      .catch((cause: unknown) => {
        if (gen !== generation) return
        setError(String((cause as { message?: string })?.message ?? cause))
        setBusy(false)
      })
  }

  const tick = () => {
    const input = ref?.current?.input ?? ""
    if (input === lastInput) return
    lastInput = input
    generation += 1
    const gen = generation
    if (debounce) {
      clearTimeout(debounce)
      debounce = undefined
    }
    const fragment = currentFragment(input)
    const lexicon = props.cfg.suggest
      ? loadLexicon(props.api.state?.path?.worktree)
      : undefined
    const list = lexicon ? suggestFor(fragment, lexicon, props.cfg.suggestLimit) : []
    setSuggestions(list)
    if (props.shared) {
      props.shared.fragment = fragment
      props.shared.suggestions = list
    }
    if (!input || input.length < props.cfg.minChars) {
      setAnalysis(EMPTY)
      setBusy(false)
      setError(undefined)
      return
    }
    const base = heuristicAnalysis(input)
    setAnalysis(base)
    setBusy(false)
    setError(undefined)
    if (!props.cfg.useModel || input.length > props.cfg.maxChars) return
    debounce = setTimeout(() => runModel(base, gen), props.cfg.debounceMs)
  }

  const poll = SELFTEST
    ? undefined
    : setInterval(tick, props.cfg.pollMs)
  if (SELFTEST) {
    setAnalysis(
      heuristicAnalysis(
        "fix it. Add a --dry-run flag to src/deploy.ts and require --confirm before deleting.",
      ),
    )
    setSuggestions(["deployPanels", "src/deploy.ts"])
  }
  onCleanup(() => {
    if (poll) clearInterval(poll)
    if (debounce) clearTimeout(debounce)
  })

  const Prompt = props.api.ui.Prompt
  return (
    <box flexDirection="column">
      <Prompt
        ref={onRef}
        sessionID={props.sessionID}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
      />
      <ErrorBoundary fallback={null}>
        <LivePanel
          analysis={analysis}
          busy={busy}
          error={error}
          suggestions={suggestions}
          acceptKey={props.cfg.acceptKey}
          theme={props.api.theme.current}
        />
      </ErrorBoundary>
    </box>
  )
}

const tui: TuiPluginModule["tui"] = async (api) => {
  debugLog("plugin loaded")
  const cfg = loadLiveConfig()
  if (!cfg.enabled) return
  const shared: Shared = { fragment: "", suggestions: [] }
  if (cfg.suggest && cfg.acceptKey) {
    try {
      api.keymap.registerLayer({
        priority: 100,
        bindings: [{ key: cfg.acceptKey, cmd: "jev.acceptSuggestion" }],
        commands: [{ name: "jev.acceptSuggestion", run: () => applySuggestion(shared) }],
      })
    } catch (cause) {
      debugLog(`keymap register failed: ${String(cause)}`)
    }
  }
  try {
    const slotId = api.slots.register({
      slots: {
        session_prompt: (_ctx: Readonly<TuiSlotContext>, props: { session_id: string; visible?: boolean; disabled?: boolean; ref?: (ref: TuiPromptRef | undefined) => void; on_submit?: () => void }) => (
          <PromptWithPanel
            api={api}
            cfg={cfg}
            sessionID={props.session_id}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit}
            hostRef={props.ref}
            shared={shared}
          />
        ),
        home_prompt: (_ctx: Readonly<TuiSlotContext>, props: { ref?: (ref: TuiPromptRef | undefined) => void }) => (
          <PromptWithPanel api={api} cfg={cfg} hostRef={props.ref} shared={shared} />
        ),
      },
    })
    debugLog(`slots registered id=${slotId}`)
  } catch (cause) {
    debugLog(`slot register failed: ${String(cause)}`)
    try {
      api.ui.toast({ variant: "error", message: `jev live panel failed to attach: ${String(cause)}` })
    } catch {
      // ignore
    }
  }
}

export default { id: "jev-prompt-assist", tui } satisfies TuiPluginModule
