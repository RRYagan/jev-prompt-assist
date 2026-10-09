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
| Content context | `jev_context` tool + `tui.tsx` (`lib/tui/content.ts`) | Matches a rough draft ("update payment") against the idx content index and returns the files/symbols/signatures that own it, plus a `sharpen:` prompt that names those targets. Works in any language. |
| Writing checks | `tui.tsx` + `lib/tui/style.ts`, `grammar.ts` | Flags ASD-STE100 and safe grammar problems in the same list; accepting a mechanical fix splices its replacement into the span. **Terminal TUI only.** |

## Layout

```
src/jev.ts            canonical server plugin (installed via symlink)
tui.tsx               canonical TUI plugin: the live prompt panel
lib/tui/              config.ts, analyze.ts (heuristics), s1.ts (model),
                      lexicon.ts (idx SQLite lexicon), content.ts (idx content
                      FTS), context.ts (target/draft building), script.ts
                      (script detection), keywords.ts (multilingual query
                      terms), suggest.ts (matching), ste100.ts (ASD data),
                      style.ts (STE rules), grammar.ts (safe grammar), panel.tsx
command/jev.md        canonical /jev command
scripts/              CPU gate model, tui-entry.mjs, ste100-fetch.mjs (dataset)
tests/                analyze/suggest/lexicon/keywords/content/context/script/
                      style/grammar/ste100 pure tests + jevs1 (s1 wiring)
docs/USAGE.md         install, dependencies, config reference, troubleshooting
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

Full walkthrough — dependencies, model bring-up, config reference and
troubleshooting — in **[`docs/USAGE.md`](docs/USAGE.md)**.

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

A fourth, **index-content** source answers a different question: *which code owns
what I am asking for?* After `contextDebounceMs` idle it searches the idx
full-text index (`code_search_fts`) with the keywords of your draft, and adds:

- `sharpen: pin the indexed targets` — rewrites the draft with a `Target:`
  (files) and `Symbols:` (function, `file:line`) block, keeping your wording;
- one `append` candidate per hit (`@file` or bare path, with the folder, line,
  language and the keywords that matched).

Measured on a 1265-file project: `update payment for momo` → 6 ms, hits like
`sales_core/payment.py:230 · checkout_payment`, `sync/apply/sales.py ·
_apply_momo_transaction`, `reports/reports.py · get_payment_method_breakdown`.
The same search is exposed server-side as the `jev_context` tool.

The same list also flags **writing problems** ahead of the completions:

- **ASD-STE100** (`lib/tui/style.ts`, a TypeScript port of the 53 Issue 9
  rules + GR-1..8) — non-approved words with an approved substitute,
  contractions, semicolons, passive voice, long sentences, noun clusters, and
  more. Mechanical rules carry a `replacement`; judgement rules are advisories.
- **General grammar** (`lib/tui/grammar.ts`) — a deliberately high-confidence
  tier: repeated words, `its'`, `then`/`than`, `affect`/`effect`, `a`/`an`,
  sentence case, double spaces, unmatched brackets/quotes, and a small
  misspelling table.

Findings render with a severity colour (error/warn/info) and their rule id.
Pressing `alt+s` on a mechanical finding replaces its span; advisory findings
do nothing. `style`/`grammar` can be toggled independently.

The full ASD dataset (Issue 9: 876 approved, 1,319 non-approved words) lives at
`~/.config/opencode/jev/ste100/dictionary.json`, fetched by
`scripts/ste100-fetch.mjs`. It is **not** part of this repo — the ASD text is
copyright and stays private. A glossary (`glossary.txt`) suppresses flags for
your technical nouns; a small built-in seed keeps the checker usable with no
dataset.

Configure under the `live` key in `~/.config/opencode/jev/config.json`:

```json
{ "live": { "enabled": true, "debounceMs": 700, "pollMs": 150,
            "minChars": 12, "maxChars": 800, "model": true,
            "suggest": true, "suggestMinChars": 2, "suggestLimit": 5,
            "suggestSources": "both", "mention": true, "suggestDebounceMs": 250,
            "context": true, "contextMinChars": 10, "contextLimit": 4,
            "contextDebounceMs": 400, "contextSources": "auto",
            "acceptKey": "alt+s", "suggestNextKey": "alt+n",
            "suggestPrevKey": "alt+p",
            "style": true, "styleLimit": 6, "grammar": true, "grammarLimit": 6,
            "styleProfile": "ste", "steDictionary": "", "glossary": "",
            "steMaxInstructionWords": 20, "steMaxDescriptiveWords": 25,
            "steFlagUnknown": false,
            "gateBaseUrl": "http://127.0.0.1:8082/v1",
            "gateModel": "jevify-gemma4-e4b" } }
```

`JEV_LIVE=0` disables the panel; `JEV_SUGGEST=0` disables suggestions;
`JEV_MENTION=0` disables `@`-mention mode; `JEV_STYLE=0` disables the STE
checks; `JEV_GRAMMAR=0` disables the grammar tier; `JEV_CONTEXT=0` disables the
content-index source; `JEV_STE_DICT` /
`JEV_GLOSSARY` point at a dictionary/glossary; `JEV_STE_UNKNOWN=1` also flags
unknown words. Debug: `JEV_TUI_DEBUG=1` (stderr
traces), `JEV_TUI_SELFTEST=1` (render a fixture below the prompt without typing).
Set any key to `""` to disable that binding; `suggestSources` accepts `"idx"`,
`"server"`, or `"both"`; `contextSources` accepts `"auto"` (only while a
completable fragment is pending), `"always"`, or `"off"`.

> **Terminal TUI only.** The `@opentui/solid` slot API does not exist in the
> desktop/web UI, so the live panel is intentionally not available there.

## Content context (`jev_context`)

`jev_context` turns a rough request into the code that owns it. It reads the same
index the panel uses, so it needs no extra tooling:

```
JEV CONTEXT — update payment for momo
worktree: /home/kr/Projects/DukaSystems/DukaLiteFull
keywords: payment, momo

targets (6):
1. dukalite-desktop/tests/test_payment_methods.py — _reset_payment_settings (python)
   excerpt: def _reset_«payment»_settings(service: StoreSettingsService) -> None:
   matched: payment momo
…
drafted prompt:
update payment for momo
Target: dukalite-desktop/tests/test_payment_methods.py, …/sync/apply/sales.py, …/sales_core/payment.py
Symbols: _reset_payment_settings, _apply_sales_payment, checkout_payment
```

| Arg | Meaning |
|---|---|
| `task` | The rough request, in any language (keywords are extracted, not translated). |
| `worktree` | Directory to search; defaults to the session's project. |
| `limit` | Max hits (default 6, max 20). |
| `detail` | Attach language/signature/doc per hit (default true). |
| `draft` | Include the drafted prompt (default true). |
| `maxFiles` | Files named in the drafted `Target:` line (default 3). |
| `criteria` | Acceptance criteria appended to the drafted prompt. |

It is local and read-only (`<worktree>/.indexer-cli/db.sqlite`, opened
`readonly`), never spawns `idx`, and degrades to a note when no snapshot exists.

## Multilanguage projects

- **Query terms** (`lib/tui/keywords.ts`) tokenize with Unicode letter classes,
  fold diacritics only the way SQLite's `unicode61 remove_diacritics 2` does
  (never blanket NFKD — that mangles Cyrillic and Hangul), split camelCase,
  `snake_case` and `kebab-case`, and drop stopwords/generic action verbs. The
  stop list covers English plus the function words of Spanish, Portuguese,
  French, German, Italian and Dutch/Nordic, so "arreglar el reembolso de pagos"
  spends its keyword budget on `arreglar, reembolso, pagos`, not on `el`/`de`.
- **Search** (`lib/tui/content.ts`) runs one FTS5 `MATCH` per keyword, plus a
  bounded `LIKE` probe for CJK runs — `unicode61` treats an unbroken CJK run as a
  single token, so bigrams are the workaround. Grouping and scoring are
  script-agnostic: a file is good when several keywords point at it.
- **Completions** (`lib/tui/suggest.ts`) match Unicode identifiers and words
  (`\p{L}`/`\p{N}` regexes); ASCII behaviour is unchanged.
- **Writing checks** are script-gated (`lib/tui/script.ts`): ASD-STE100 and the
  English grammar tier are skipped for non-Latin drafts, so a Korean prompt is
  not flagged as bad English. The vague-prompt heuristic now also recognises
  targets in any script (CJK/Hangul words, `snake_case`, digits, `@mentions`).
- Hit details carry the file's `language_id`, and the notes list the languages
  present in the targets.

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
`JEV_GATE_BASE_URL`, `JEV_GATE_MODEL`, `JEV_S1_BIN`, `JEV_S1_TIMEOUT_MS`,
`JEV_PARAMS=1`.

Per-project guide: `<project>/.opencode/jev.json` → `{ "guide": "..." }`.
Global guide: `~/.config/opencode/jev/guide.md`.

## Lightweight CPU model (gate)

The default `s1` backend is `s1-cpu.service` on `:8081` (Gemma-E4B, Q5_K_M,
`-ngl 0`). `scripts/setup-gate.sh` requantizes to Q4_K_M and serves a second CPU
instance on `:8082`:

```sh
scripts/setup-gate.sh      # requant + install systemd unit + health check
scripts/uninstall-gate.sh  # disable + remove (keeps the model file)
systemctl --user start s1-cpu     # the default backend, if it is not running
s1 doctor --cpu                   # endpoint + model + card example
```

Measured here: Q4 gate is ~**1.6× faster** than Q5 with the same decisions
(noul 1770→1098 ms; batched `ask` 4035→2551 ms). The requant is only ~7% smaller
in bytes — the win is latency, not RAM.

Route behaviour in the plugin: interactive hooks (the intent hint) take the gate
while it answers and **fall back to the resident CPU route** when it refuses a
connection (remembered for 5 min, probe ≈1 ms); a tool called with `gate: true`
reports the failure with the command that fixes it. Every s1 call is bounded by
`JEV_S1_TIMEOUT_MS` (30 s default, child killed) and retried once when
llama-server answers `503 Loading model`; failures are never cached. Results are
keyed by route, so a CPU answer is never replayed for a gate request.

## Verification

```sh
bun build src/jev.ts --target=bun            # syntax/imports
bun test tests                               # 135 pass / 397 expects
s1 doctor --cpu                              # :8081 endpoint + model
s1 noul --base-url http://127.0.0.1:8082/v1 \
  --model jevify-gemma4-e4b --state '...' --question '...'   # gate
```

(`bun build tui.tsx` fails only on `@opentui/core`'s uninstalled per-platform
optional packages — pre-existing, and irrelevant: opencode loads `tui.tsx`
itself, not a bundle. Use `--packages external` to bundle it anyway.)

## Notes

- `s1` inputs are English-centric and calibrated on average, not per task. Treat
  results as one input to a decision, not policy. The `jev_context` search, in
  contrast, is language independent — it matches identifiers and paths, not
  grammar.
- Prefill dominates CPU latency (~10–12 ms/token); keep interactive states
  short and batch questions with `s1 ask`.
- Results are content-hash cached in `~/.cache/opencode/jev/`; the session ledger
  lives in `~/.config/opencode/jev/sessions/`.
- The panel render path is total (no non-null reads) and wrapped in a Solid
  `<ErrorBoundary>`, so a rendering fault degrades to "no panel" instead of
  crashing the TUI.
- The ASD-STE100 dictionary and rule text are copyright ASD. The fetched
  dataset stays in `~/.config/opencode/jev/ste100/` and is never committed to
  this (MIT) repo. `tests/style.test.ts` asserts every one of the 53 rules is
  accounted for as auto / advisory / manual.
- dsh integration is **deferred** (opencode-only for now); see `PLAN.md` §7.

## NB: STILL UNDER DEVELOPMENT
