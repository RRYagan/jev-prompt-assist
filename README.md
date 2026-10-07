# jev-prompt-assist

An **opencode plugin** that wires the local Jev/System-1 classifier (`s1`) into
your agent as a fast, calibrated, CPU-only decision primitive. It generates
**zero output tokens**: `s1` reads the first-token logprobs of answer labels, so
every call is cheap and deterministic.

The controllable surface is only the `state`, the `instructions` (question), and
the `criteria` (option/level descriptions). This plugin's job is to craft those
well, route them, and feed the results back into the session.

## What it does

| Surface | Hook / tool | Effect |
|---|---|---|
| Prompt crafting | `jev_prompt` tool | Turns a rough task + state into an optimal `noul`/`choice`/`score` prompt, with notes. Optionally runs it. |
| One-shot entry | `/jev` command | Same, from a single slash command. |
| Underspecified-prompt hint | `chat.message` | Heuristically detects vague prompts and appends a short `[jev-intent]` classification (debounced). |
| Per-project prompting | `experimental.chat.system.transform` | Injects a project/global guide into the system prompt. |
| Self-consistency | `jev_prompt { verify: true }` | Reverses option/level order; a flip is reported as `review`. |
| Fast gate | `jev_prompt { gate: true }` | Routes the call to the lightweight Q4 endpoint (`:8082`). |
| Compaction safety | `experimental.session.compacting` | Carries the guide + recent decisions through compaction. |
| Deterministic params | `chat.params` (`JEV_PARAMS=1`) | Pins temperature ≤0.2 for judge/review/plan/compaction/test-gen. |
| Live prompt panel | `tui.tsx` (TUI plugin) | As you type, colours each sentence, shows a `score/100`, and suggests fixes. **Terminal TUI only.** |
| Project autosuggest | `tui.tsx` + idx/server (`lib/tui/suggest.ts`) | Ranked `did you mean:` symbol/file matches (prefix/camelCase/subsequence/typo), `@`-mention mode, hot+recent boosts; cycle with `alt+n/p` and accept with `alt+s`. **Terminal TUI only.** |

## Layout

```
src/jev.ts            canonical server plugin (installed via symlink)
tui.tsx               canonical TUI plugin: the live prompt panel
lib/tui/              config.ts, analyze.ts (heuristics), s1.ts (model),
                      lexicon.ts (idx SQLite lexicon), suggest.ts (matching), panel.tsx
command/jev.md        canonical /jev command
scripts/              CPU gate model + tui-entry.mjs (manages the tui.json entry)
tests/                analyze/suggest/lexicon pure tests
dsh/dsh-hook.mjs      phase-2 scaffolding (deferred, unwired)
PLAN.md               full design + measurements
install.sh            symlinks + adds the tui.json entry
uninstall.sh          remove those
```

## Install

```sh
bun install          # provides @opencode-ai/plugin + @opentui/{core,solid}
./install.sh         # symlinks + adds a file://.../tui.tsx entry to tui.json
```

Then **restart opencode** — config and plugins are read once at startup.

The symlinks make this repo the single source of truth: edit here and opencode
loads it. `install.sh` also registers the TUI plugin by appending
`file://…/tui.tsx` to `~/.config/opencode/tui.json` `plugin` (idempotent,
preserving existing entries). To remove everything, run `./uninstall.sh`.

## Live prompt panel (terminal TUI)

As you type, a compact panel appears **below the prompt** with a per-sentence
colour (green/amber/red), a live `score/100`, a status (`instant` heuristic →
`classified` after the model pass), and the top suggestions.

Two tiers keep it responsive despite ~1 s CPU `s1` latency:

1. **Instant heuristics** — sentence splitting + regex signals, on every keystroke.
2. **Debounced s1** — one batched `s1 ask` after `debounceMs` idle, merged at
   0.6 model / 0.4 heuristic and cached.

A third, **model-free** source adds project-context suggestions. It merges two
fast sources:

- **idx lexicon** — reads `<worktree>/.indexer-cli/db.sqlite` directly with
  `bun:sqlite` (read-only; never spawns `idx`, which costs 10–54 s and takes a
  lock) into an in-memory symbol/file list.
- **opencode server** — a debounced `find.symbols`/`find.files` query, which
  works even with no index and is always current.

Matching is ranked: case-insensitive prefix → camelCase initialism (`gp` →
`getProject`) → subsequence → substring → typo tolerance (edit distance 1).
Files you are editing (git status) and identifiers already used earlier in the
session are boosted. Typing `@` switches to file-mention mode (`@src/render.ts`).
The list shows as `did you mean:`; `alt+n` / `alt+p` cycle and
`alt+s` accepts the selected candidate. Absent or unfinished indexes are
ignored gracefully.

Configure under the `live` key in `~/.config/opencode/jev/config.json`:

```json
{ "live": { "enabled": true, "debounceMs": 700, "pollMs": 150,
            "minChars": 12, "maxChars": 800, "model": true,
            "suggest": true, "suggestMinChars": 2, "suggestLimit": 5,
            "suggestSources": "both", "mention": true, "suggestDebounceMs": 250,
            "acceptKey": "alt+s", "suggestNextKey": "alt+n",
            "suggestPrevKey": "alt+p",
            "gateBaseUrl": "http://127.0.0.1:8082/v1",
            "gateModel": "jevify-gemma4-e4b" } }
```

`JEV_LIVE=0` disables the panel; `JEV_SUGGEST=0` disables suggestions;
`JEV_MENTION=0` disables `@`-mention mode. Debug: `JEV_TUI_DEBUG=1` (stderr
traces), `JEV_TUI_SELFTEST=1` (render a fixture below the prompt without typing).
Set any key to `""` to disable that binding; `suggestSources` accepts `"idx"`,
`"server"`, or `"both"`.

> **Terminal TUI only.** The `@opentui/solid` slot API does not exist in the
> desktop/web UI, so the live panel is intentionally not available there.

## Configure

Persistent config: `~/.config/opencode/jev/config.json` (template in
`scripts/config.example.json`). Precedence: **defaults < file < env < plugin
options**.

```json
{ "fast": false, "intentHint": true, "guide": true, "cache": true,
  "maxStateChars": 4000,
  "gateBaseUrl": "http://127.0.0.1:8082/v1", "gateModel": "jevify-gemma4-e4b" }
```

Env overrides: `JEV_FAST=1` (GPU), `JEV_INTENT=0`, `JEV_GUIDE=0`, `JEV_CACHE=0`,
`JEV_GATE_BASE_URL`, `JEV_GATE_MODEL`, `JEV_PARAMS=1`.

Per-project guide: `<project>/.opencode/jev.json` → `{ "guide": "..." }`.
Global guide: `~/.config/opencode/jev/guide.md`.

## Lightweight CPU model (gate)

The default `s1` backend is `s1-cpu.service` on `:8081` (Gemma-E4B, Q5_K_M,
`-ngl 0`). `scripts/setup-gate.sh` requantizes to Q4_K_M and serves a second CPU
instance on `:8082`:

```sh
scripts/setup-gate.sh      # requant + install systemd unit + health check
scripts/uninstall-gate.sh  # disable + remove (keeps the model file)
```

Measured here: Q4 gate is ~**1.6× faster** than Q5 with the same decisions
(noul 1770→1098 ms; batched `ask` 4035→2551 ms). The requant is only ~7% smaller
in bytes — the win is latency, not RAM.

## Verification

```sh
bun build src/jev.ts --target=bun            # syntax/imports
s1 doctor --cpu                              # :8081 endpoint + model
s1 noul --base-url http://127.0.0.1:8082/v1 \
  --model jevify-gemma4-e4b --state '...' --question '...'   # gate
```

## Notes

- `s1` inputs are English-centric and calibrated on average, not per task. Treat
  results as one input to a decision, not policy.
- Prefill dominates CPU latency (~10–12 ms/token); keep interactive states
  short and batch questions with `s1 ask`.
- Results are content-hash cached in `~/.cache/opencode/jev/`; the session ledger
  lives in `~/.config/opencode/jev/sessions/`.
- The panel render path is total (no non-null reads) and wrapped in a Solid
  `<ErrorBoundary>`, so a rendering fault degrades to "no panel" instead of
  crashing the TUI.
- dsh integration is **deferred** (opencode-only for now); see `PLAN.md` §7.
