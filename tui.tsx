/** @jsxImportSource @opentui/solid */
// jev-prompt-assist — TUI half.
//
// Renders the prompt with a live annotation panel directly beneath it:
//   • Tier 1 (instant, no model): local heuristics score + per-sentence colours
//   • Tier 2 (debounced): a batched `s1 ask` pass refines the score
//   • Autosuggest: ranked project-context candidates (symbols/files), from the
//     idx lexicon and/or the server find API, plus `@mention` file paths
//
// The panel is terminal-TUI only. The opencode desktop/web apps do not load
// @opentui slot plugins; see README/PLAN.
import type { TuiPluginModule, TuiPromptRef, TuiSlotContext } from "@opencode-ai/plugin/tui"
import type { Accessor, Setter } from "solid-js"
import { ErrorBoundary, createSignal, onCleanup } from "solid-js"
import { relative } from "node:path"
import { loadLiveConfig, type LiveConfig } from "./lib/tui/config"
import { heuristicAnalysis, mergeAnalysis, type Analysis } from "./lib/tui/analyze"
import { scoreWithS1 } from "./lib/tui/s1"
import { loadLexicon } from "./lib/tui/lexicon"
import { searchContent } from "./lib/tui/content"
import { contextSuggestions } from "./lib/tui/context"
import { allowsEnglishLint } from "./lib/tui/script"
import { lintSte, type StyleIssue } from "./lib/tui/style"
import { lintGrammar } from "./lib/tui/grammar"
import { loadSteData } from "./lib/tui/ste100"
import {
  applySuggestion,
  basename,
  currentFragment,
  currentMention,
  dirname,
  suggest,
  symbolKindLabel,
  type Suggestion,
} from "./lib/tui/suggest"
import { LivePanel } from "./lib/tui/panel"

type TuiApi = Parameters<TuiPluginModule["tui"]>[0]

// The analysis signal is never undefined: an empty draft yields this neutral
// value, so the panel's render path has no null dereferences (the old
// `state()!.tips` crash).
const EMPTY: Analysis = { score: 0, level: "weak", segments: [], tips: [], tier: "heuristic" }

const SEVERITY_MARK: Record<StyleIssue["severity"], string> = { error: "✖", warn: "▲", info: "•" }

/** Convert a style/grammar finding into a list entry. Value is "" for advisories. */
function issueToSuggestion(issue: StyleIssue): Suggestion {
  const mark = SEVERITY_MARK[issue.severity]
  return {
    value: issue.replacement ?? "",
    label: issue.replacement
      ? `${mark} ${issue.label} → ${issue.replacement}`
      : `${mark} ${issue.label}`,
    detail: `${issue.rule} · ${issue.detail}`,
    kind: "style",
    span: issue.span,
    severity: issue.severity,
  }
}

// State shared between the rendered prompt and the global keymap layer (the
// accept/cycle bindings run outside the component, so they need the live ref,
// the latest candidates and the selection).
type Shared = {
  ref?: TuiPromptRef
  /** The trailing token to replace (includes a leading `@` in mention mode). */
  fragment: string
  mention: boolean
  /** Input value accepted last; suppresses re-suggesting the same token. */
  suppress: string
  items: Accessor<Suggestion[]>
  setItems: Setter<Suggestion[]>
  selected: Accessor<number>
  setSelected: Setter<number>
  /** Lowercased paths touched by git — ranked first within a tier. */
  hotFiles: Set<string>
  /** Lowercased identifiers seen in the session — ranked first within a tier. */
  recent: Set<string>
  accept: () => void
  move: (delta: number) => void
}

function acceptSuggestion(shared: Shared): void {
  try {
    const ref = shared.ref
    const list = shared.items()
    const item = list[shared.selected() ?? 0]
    if (!ref || !item) return
    const current = ref.current
    const input = current?.input ?? ""

    // Every branch lands here: publish the new draft and drop the list.
    const commit = (next: string) => {
      ref.set({ input: next, parts: current?.parts ?? [] })
      ref.focus()
      shared.setItems([])
      shared.setSelected(0)
      shared.suppress = next
      shared.fragment = ""
    }

    // Span (style/grammar), whole-draft rewrite (sharpen), appended target
    // (@file), or the trailing fragment — all decided by `applySuggestion`.
    const next = applySuggestion(input, shared.fragment, item)
    if (next) commit(next)
  } catch {
    // never let the accept binding throw into the TUI
  }
}

function moveSelection(shared: Shared, delta: number): void {
  const count = shared.items().length
  if (count === 0) return
  shared.setSelected((prev) => {
    const current = (prev ?? 0) % count
    return (current + delta + count) % count
  })
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

function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri
}

function relPath(worktree: string | undefined, file: string): string {
  if (!worktree) return file
  try {
    const rel = relative(worktree, file)
    return rel && !rel.startsWith("..") ? rel : file
  } catch {
    return file
  }
}

async function serverSuggest(
  api: TuiApi,
  query: string,
  mention: boolean,
  limit: number,
): Promise<Suggestion[]> {
  try {
    const find = api.client?.find
    if (!find || query.length < 2) return []
    const worktree = api.state?.path?.worktree
    if (mention) {
      const res = await find.files({ query, limit })
      const files = res.data ?? []
      return files.slice(0, limit).map((path) => ({
        value: `@${path}`,
        label: basename(path),
        detail: dirname(path) || undefined,
        kind: "mention",
      }))
    }
    const [symbolRes, fileRes] = await Promise.all([
      find.symbols({ query }).catch(() => undefined),
      find.files({ query, limit }).catch(() => undefined),
    ])
    const out: Suggestion[] = []
    for (const symbol of symbolRes?.data ?? []) {
      if (out.length >= limit) break
      const file = symbol.location?.uri ? uriToPath(symbol.location.uri) : ""
      out.push({
        value: symbol.name,
        label: symbol.name,
        detail:
          [symbolKindLabel(symbol.kind), relPath(worktree, file)].filter(Boolean).join(" · ") ||
          undefined,
        kind: "symbol",
      })
    }
    for (const path of fileRes?.data ?? []) {
      if (out.length >= limit) break
      out.push({
        value: query.includes("/") ? path : basename(path),
        label: basename(path),
        detail: dirname(path) || undefined,
        kind: "path",
      })
    }
    return out
  } catch {
    return []
  }
}

function refreshHotFiles(api: TuiApi, shared: Shared): void {
  try {
    const status = api.client?.file?.status
    if (!status) return
    status()
      .then((res) => {
        const files = res.data ?? []
        if (files.length === 0) return
        shared.hotFiles.clear()
        for (const file of files) shared.hotFiles.add(file.path.toLowerCase())
      })
      .catch(() => {
        /* ignore */
      })
  } catch {
    /* ignore */
  }
}

function refreshRecent(api: TuiApi, shared: Shared, sessionID: string | undefined): void {
  if (!sessionID) return
  try {
    const messages = api.state?.session?.messages(sessionID) ?? []
    const recent = shared.recent
    recent.clear()
    for (const message of messages.slice(-15)) {
      if (recent.size > 2000) break
      const parts = api.state.part(message.id) ?? []
      for (const part of parts) {
        if ((part as { type?: string }).type !== "text") continue
        const text = (part as { text?: string }).text
        if (!text) continue
        // Unicode identifiers: `\p{L}` covers 支払い処理 or платежей, not just fooBar.
        const matches = text.match(/[\p{L}_$@][\p{L}\p{N}_$]{2,}/gu)
        if (matches) for (const match of matches) recent.add(match.toLowerCase())
      }
    }
  } catch {
    /* ignore */
  }
}

interface PanelProps {
  api: TuiApi
  cfg: LiveConfig
  shared: Shared
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  hostRef?: (ref: TuiPromptRef | undefined) => void
}

function PromptWithPanel(props: PanelProps) {
  const [analysis, setAnalysis] = createSignal<Analysis>(EMPTY)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  let ref: TuiPromptRef | undefined
  let lastInput = ""
  let generation = 0
  let modelDebounce: ReturnType<typeof setTimeout> | undefined
  let suggestDebounce: ReturnType<typeof setTimeout> | undefined
  let contextDebounce: ReturnType<typeof setTimeout> | undefined
  let hotTimer: ReturnType<typeof setInterval> | undefined
  let recentTimer: ReturnType<typeof setInterval> | undefined

  const onRef = (value: TuiPromptRef | undefined) => {
    ref = value
    props.shared.ref = value
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

  const runServer = (query: string, mention: boolean, gen: number) => {
    serverSuggest(props.api, query, mention, props.cfg.suggestLimit).then((extra) => {
      if (gen !== generation || extra.length === 0) return
      const merged = [...props.shared.items()]
      const seen = new Set(merged.map((item) => item.value))
      for (const item of extra) {
        if (merged.length >= props.cfg.suggestLimit + 8) break
        if (seen.has(item.value)) continue
        seen.add(item.value)
        merged.push(item)
      }
      props.shared.setItems(merged)
    })
  }

  // Content-index pass: search the idx index for the files/functions the draft
  // talks about, and surface them as append-only targets plus a `sharpen:`
  // rewrite. Never throws (searchContent swallows index errors), but the timer
  // callback still guards the generation so a stale draft cannot win.
  const runContext = (input: string, gen: number) => {
    try {
      const worktree = props.api.state?.path?.worktree
      const hits = searchContent(worktree, input, { limit: props.cfg.contextLimit })
      if (gen !== generation || hits.length === 0) return
      const extra = contextSuggestions(input, hits, {
        limit: props.cfg.contextLimit,
        mention: props.cfg.mention,
      })
      if (extra.length === 0) return
      const kept = props.shared.items().filter((item) => item.kind !== "context")
      props.shared.setItems([...kept, ...extra])
    } catch {
      // diagnostics only: the panel must survive a broken index
    }
  }

  /** Whether this draft is prose worth a content search (not a bare token). */
  const wantsContext = (input: string, prefix: string): boolean => {
    if (!props.cfg.context || props.cfg.contextSources === "off") return false
    if (input.trim().length < props.cfg.contextMinChars) return false
    if (props.cfg.contextSources === "always") return true
    // auto: only when there is text before the token being completed. A lone
    // identifier is a completion request, not a task description.
    return prefix.trim().length >= 2
  }

  const scheduleContext = (input: string, prefix: string, gen: number) => {
    if (contextDebounce) {
      clearTimeout(contextDebounce)
      contextDebounce = undefined
    }
    if (!wantsContext(input, prefix)) return
    contextDebounce = setTimeout(() => runContext(input, gen), props.cfg.contextDebounceMs)
  }

  // Style (STE) + grammar findings, converted to list entries. Best-effort:
  // a missing dictionary or a rule error never breaks the panel. Both tiers
  // are English-only, so they are skipped for a draft written in another
  // script (otherwise every Japanese sentence draws spelling noise).
  const collectFindings = (input: string): Suggestion[] => {
    if (!props.cfg.style && !props.cfg.grammar) return []
    if (!allowsEnglishLint(input)) return []
    const out: Suggestion[] = []
    try {
      if (props.cfg.grammar) {
        out.push(...lintGrammar(input, { limit: props.cfg.grammarLimit }).map(issueToSuggestion))
      }
      if (props.cfg.style) {
        const data = loadSteData({
          dictionary: props.cfg.steDictionary || undefined,
          glossary: props.cfg.glossary || undefined,
        })
        if (data.loaded) {
          out.push(
            ...lintSte(input, {
              data,
              maxInstructionWords: props.cfg.steMaxInstructionWords,
              maxDescriptiveWords: props.cfg.steMaxDescriptiveWords,
              flagUnknown: props.cfg.steFlagUnknown,
              limit: props.cfg.styleLimit,
            }).map(issueToSuggestion),
          )
        }
      }
    } catch {
      // findings are best-effort
    }
    out.sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0))
    const dedup = new Set<string>()
    return out.filter((item) => {
      const key = `${item.span?.start ?? -1}:${item.span?.end ?? -1}:${item.label}`
      if (dedup.has(key)) return false
      dedup.add(key)
      return true
    })
  }

  const updateAssists = (input: string, gen: number) => {
    const findings = collectFindings(input)
    props.shared.fragment = ""
    props.shared.mention = false

    if (!props.cfg.suggest) {
      props.shared.setItems(findings)
      // No completions to show, so the index pass is the only context source.
      scheduleContext(input, input, gen)
      return
    }
    const mentionToken = props.cfg.mention ? currentMention(input) : undefined
    const mention = Boolean(mentionToken)
    const fragment = mention ? mentionToken! : currentFragment(input)
    props.shared.fragment = fragment
    props.shared.mention = mention
    props.shared.setSelected(0)
    // Prose (text before the token being completed) triggers the index pass.
    scheduleContext(input, input.slice(0, input.length - fragment.length), gen)

    const query = mention ? fragment.slice(1) : fragment
    const min = mention ? 1 : props.cfg.suggestMinChars
    if (query.length < min) {
      props.shared.setItems(findings)
      return
    }

    let list: Suggestion[] = []
    if (props.cfg.suggestSources !== "server") {
      const lexicon = loadLexicon(props.api.state?.path?.worktree)
      if (lexicon) {
        list = suggest(query, lexicon, {
          limit: props.cfg.suggestLimit,
          mention,
          hotFiles: props.shared.hotFiles,
          recent: props.shared.recent,
        })
      }
    }
    // Findings rank ahead of name completions.
    props.shared.setItems([...findings, ...list].slice(0, Math.max(1, props.cfg.suggestLimit + 8)))

    if (props.cfg.suggestSources !== "idx") {
      suggestDebounce = setTimeout(() => runServer(query, mention, gen), props.cfg.suggestDebounceMs)
    }
  }

  const tick = () => {
    const input = ref?.current?.input ?? ""
    if (input === lastInput) return
    lastInput = input
    if (input && input === props.shared.suppress) return
    props.shared.suppress = ""
    generation += 1
    const gen = generation
    if (modelDebounce) {
      clearTimeout(modelDebounce)
      modelDebounce = undefined
    }
    if (suggestDebounce) {
      clearTimeout(suggestDebounce)
      suggestDebounce = undefined
    }
    if (contextDebounce) {
      clearTimeout(contextDebounce)
      contextDebounce = undefined
    }

    updateAssists(input, gen)

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
    modelDebounce = setTimeout(() => runModel(base, gen), props.cfg.debounceMs)
  }

  const poll = SELFTEST ? undefined : setInterval(tick, props.cfg.pollMs)
  if (SELFTEST) {
    setAnalysis(
      heuristicAnalysis(
        "fix it. Add a --dry-run flag to src/deploy.ts and require --confirm before deleting.",
      ),
    )
    props.shared.setItems([
      { value: "deployPanels", label: "deployPanels", detail: "function · src/panel.ts", kind: "symbol" },
      { value: "@src/deploy.ts", label: "deploy.ts", detail: "src", kind: "mention" },
      {
        value:
          "fix the payment flow for momo\nTarget: src/modules/sales_core/payment.py\nSymbols: checkout_payment (payment.py:230)",
        label: "sharpen: pin the indexed targets",
        detail: "2 matches → Target + Symbols",
        kind: "context",
        replaceAll: true,
      },
      {
        value: "@src/modules/sales_core/payment.py",
        label: "checkout_payment",
        detail: "…/modules/sales_core · L230 · python · matched: payment",
        kind: "context",
        append: true,
      },
      {
        value: "receive",
        label: "▲ spelling → receive",
        detail: "GM-spelling · use “receive”",
        kind: "style",
        span: { start: 0, end: 7 },
        severity: "warn",
      },
    ])
  }
  if (props.sessionID) {
    try {
      refreshHotFiles(props.api, props.shared)
      hotTimer = setInterval(() => refreshHotFiles(props.api, props.shared), 15000)
      refreshRecent(props.api, props.shared, props.sessionID)
      recentTimer = setInterval(
        () => refreshRecent(props.api, props.shared, props.sessionID),
        8000,
      )
    } catch {
      /* ignore */
    }
  }
  onCleanup(() => {
    if (poll) clearInterval(poll)
    if (modelDebounce) clearTimeout(modelDebounce)
    if (suggestDebounce) clearTimeout(suggestDebounce)
    if (contextDebounce) clearTimeout(contextDebounce)
    if (hotTimer) clearInterval(hotTimer)
    if (recentTimer) clearInterval(recentTimer)
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
          suggestions={props.shared.items}
          selected={props.shared.selected}
          acceptKey={props.cfg.acceptKey}
          nextKey={props.cfg.suggestNextKey}
          prevKey={props.cfg.suggestPrevKey}
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
  const [items, setItems] = createSignal<Suggestion[]>([])
  const [selected, setSelected] = createSignal(0)
  const shared: Shared = {
    ref: undefined,
    fragment: "",
    mention: false,
    suppress: "",
    items,
    setItems,
    selected,
    setSelected,
    hotFiles: new Set<string>(),
    recent: new Set<string>(),
    accept: () => acceptSuggestion(shared),
    move: (delta) => moveSelection(shared, delta),
  }
  if (cfg.suggest || cfg.style || cfg.grammar || cfg.context) {
    const bindings: Array<{ key: string; cmd: string }> = []
    if (cfg.acceptKey) bindings.push({ key: cfg.acceptKey, cmd: "jev.acceptSuggestion" })
    if (cfg.suggestNextKey) bindings.push({ key: cfg.suggestNextKey, cmd: "jev.nextSuggestion" })
    if (cfg.suggestPrevKey) bindings.push({ key: cfg.suggestPrevKey, cmd: "jev.prevSuggestion" })
    try {
      api.keymap.registerLayer({
        priority: 100,
        bindings,
        commands: [
          { name: "jev.acceptSuggestion", run: () => shared.accept() },
          { name: "jev.nextSuggestion", run: () => shared.move(1) },
          { name: "jev.prevSuggestion", run: () => shared.move(-1) },
        ],
      })
    } catch (cause) {
      debugLog(`keymap register failed: ${String(cause)}`)
    }
  }
  try {
    const slotId = api.slots.register({
      slots: {
        session_prompt: (
          _ctx: Readonly<TuiSlotContext>,
          props: {
            session_id: string
            visible?: boolean
            disabled?: boolean
            ref?: (ref: TuiPromptRef | undefined) => void
            on_submit?: () => void
          },
        ) => (
          <PromptWithPanel
            api={api}
            cfg={cfg}
            shared={shared}
            sessionID={props.session_id}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit}
            hostRef={props.ref}
          />
        ),
        home_prompt: (
          _ctx: Readonly<TuiSlotContext>,
          props: { ref?: (ref: TuiPromptRef | undefined) => void },
        ) => <PromptWithPanel api={api} cfg={cfg} shared={shared} hostRef={props.ref} />,
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
