/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { heuristicAnalysis, type Analysis } from "../lib/tui/analyze"
import { LivePanel } from "../lib/tui/panel"

const theme = {
  text: "#eeeeee",
  textMuted: "#808080",
  accent: "#5c9cf5",
  success: "#7fef8f",
  warning: "#f0a030",
  error: "#e06c75",
} as unknown as TuiThemeCurrent

let destroy: (() => void) | undefined
afterEach(() => {
  try {
    destroy?.()
  } catch {
    /* ignore */
  }
  destroy = undefined
})

describe("LivePanel", () => {
  test("survives a defined -> undefined analysis transition", async () => {
    // Regression: deleting the whole prompt clears the analysis signal, and
    // Solid may re-run a branch child before the outer condition updates. The
    // old `state()!.tips` non-null reads crashed the TUI here.
    const [analysis, setAnalysis] = createSignal<Analysis | undefined>(
      heuristicAnalysis("Add a --dry-run flag to src/deploy.ts."),
    )
    const setup = await testRender(() => (
      <LivePanel
        analysis={analysis}
        busy={() => false}
        error={() => undefined}
        suggestions={() => [
          { value: "deployPanels", label: "deployPanels", detail: "function", kind: "symbol" },
          { value: "@src/deploy.ts", label: "deploy.ts", detail: "src", kind: "mention" },
        ]}
        selected={() => 0}
        acceptKey="ctrl+shift+s"
        nextKey="ctrl+shift+n"
        prevKey="ctrl+shift+p"
        theme={theme}
      />
    ))
    destroy = () => setup.renderer.destroy()

    await setup.flush()
    setAnalysis(undefined)
    await setup.flush()

    const frame = setup.captureCharFrame()
    expect(frame).toContain("did you mean")
    expect(frame).not.toContain("undefined")
  })
})
