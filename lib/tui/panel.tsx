/** @jsxImportSource @opentui/solid */
// The live annotation panel rendered directly below the prompt: a compact
// score line, the draft re-rendered with per-sentence colours, and the top
// suggestions.
//
// Note: @opentui's text-node JSX types (`span`, `b`, `strong`, ...) do not
// expose `fg` (upstream typing gap), so coloured runs are rendered as sibling
// <text> nodes inside a wrapping row.
import type { Accessor } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Analysis, Level } from "./analyze"
import type { Suggestion } from "./suggest"

function colorFor(level: Level, theme: TuiThemeCurrent) {
  if (level === "good") return theme.success
  if (level === "ok") return theme.warning
  return theme.error
}

function clip(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > max ? compact.slice(0, max - 1) + "…" : compact
}

export function LivePanel(props: {
  analysis: Accessor<Analysis | undefined>
  busy: Accessor<boolean>
  error: Accessor<string | undefined>
  suggestions: Accessor<Suggestion[]>
  selected: Accessor<number>
  /** Shown as a key hint next to suggestions; empty hides it. */
  acceptKey?: string
  nextKey?: string
  prevKey?: string
  theme: TuiThemeCurrent
}) {
  // Every read is total: the analysis signal may be undefined between keystrokes
  // (tick() clears it), and Solid may re-run a branch child before the outer
  // condition updates. Never use non-null assertions here — doing so crashed
  // the TUI with "undefined is not an object (evaluating 'state().tips')".
  const s = () => props.analysis()
  const segments = () => s()?.segments ?? []
  const level = () => s()?.level ?? "weak"
  const score = () => s()?.score ?? 0
  const tier = () => s()?.tier ?? "heuristic"
  const tips = () => s()?.tips ?? []
  const status = () => (props.busy() ? "  scoring…" : tier() === "s1" ? "  classified" : "  instant")
  const items = () => props.suggestions() ?? []
  const selectedIndex = () => {
    const count = items().length
    if (count === 0) return 0
    const index = props.selected() ?? 0
    return Math.max(0, Math.min(index, count - 1))
  }
  const cycleHint = () => {
    const parts: string[] = []
    if (props.nextKey && props.prevKey) parts.push(`${props.nextKey}/${props.prevKey} cycle`)
    if (props.acceptKey) parts.push(`${props.acceptKey} accept`)
    return parts.length ? `  (${parts.join(", ")})` : ""
  }
  return (
    <box flexDirection="column" paddingLeft={1}>
      {segments().length ? (
        <>
          <box flexDirection="row" flexWrap="wrap">
            <text fg={props.theme.textMuted}>{"jev "}</text>
            <text fg={colorFor(level(), props.theme)}>{`${Math.round(score() * 100)}/100`}</text>
            <text fg={props.theme.textMuted}>{`${status()}  ·  ${level()}`}</text>
          </box>
          <box flexDirection="row" flexWrap="wrap">
            {segments().map((segment) => (
              <text fg={colorFor(segment.level, props.theme)}>{`${clip(segment.text)} `}</text>
            ))}
          </box>
          {props.error() ? (
            <text fg={props.theme.error}>{`s1: ${props.error()}`}</text>
          ) : tips().length ? (
            <text fg={props.theme.textMuted}>{tips().join("  ·  ")}</text>
          ) : null}
        </>
      ) : null}
      {items().length ? (
        <box flexDirection="column">
          <text fg={props.theme.textMuted}>{`did you mean:${cycleHint()}`}</text>
          {items().map((item, index) => (
            <box flexDirection="row">
              <text fg={index === selectedIndex() ? props.theme.accent : props.theme.textMuted}>
                {index === selectedIndex() ? "▸ " : "  "}
              </text>
              <text fg={index === selectedIndex() ? props.theme.text : props.theme.textMuted}>
                {item.label}
              </text>
              {item.detail ? (
                <text fg={props.theme.textMuted}>{`  ${item.detail}`}</text>
              ) : null}
            </box>
          ))}
        </box>
      ) : null}
    </box>
  )
}
