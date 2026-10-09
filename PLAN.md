# Jev / System-1 plugin for opencode + dsh — plan & analysis

Status: **v5 implemented** (opencode-only, per user scope): server plugin v2 + a
terminal-TUI **live prompt panel** with **project-context autosuggest** and
**ASD-STE100 + grammar writing checks**. dsh bridge = deferred (phase 2).
**Desktop/web is intentionally out of scope** — the live panel is terminal-TUI only.
Author context: opencode, local-first, CPU-first (`-ngl 0`), zero paid tokens.

## Goal

Build a plugin that uses the local Jev/System-1 classifier (`s1`) to:

1. find a lightweight, effective CPU model;
2. help craft prompts that the classifier actually understands;
3. improve prompts per context / session / project;
4. add features that enhance model output via prompting;
5. optimise token usage.

Hard constraint: Jev reads the **first-token logprobs of answer labels** and
generates **zero output tokens**. The only controllable surface is the `state`,
the `instructions` (question), and the `criteria` (option / level descriptions).

## Measured baseline (this machine)

| case | input tokens | latency |
|---|---|---|
| single `noul` (s1, `--cpu`) | 63 | **1.05 s** |
| 3-question `ask` / 256 tok (`s1 doctor --cpu`) | 256 | **14.1 s** |

CPU: AMD Ryzen 5 7500F (6c/12t, AVX-512, 4.0 GHz). Prefill dominates
(~10–12 ms/token on `-ngl 0`). **Design rule: interactive states stay
< ~150 tokens; batch N questions over ONE state via `s1 ask` (shared prefill).**

## Existing assets (build on, don't duplicate)

- `~/.config/opencode/tools/s1.ts` — native `s1` tool (noul/choice/score, CPU default).
- `~/.config/opencode/agents/judge.md` — `@judge` subagent (read + s1 only).
- `~/.local/share/s1-adapter/` — CLI + `jevify` runtime.
- Model served by `s1-cpu.service` (:8081, `-ngl 0`), GPU via llama-swap (:8080).

The plugin is an **orchestration layer** on top of these.

## 1. Lightweight CPU model — options

Current model `jevify-gemma4-e4b.Q5_K_M` = 5.7 GB (accurate, prefill-heavy).
Ranked:

| Option | Size | Status | Note |
|---|---|---|---|
| **Q4_K_M requant of current model** | ~5.1 GB (measured) | **implemented** | Drop-in, same renderer, ~1.6× faster; measured only ~7% smaller (llama.cpp keeps many tensors q6_K). See `scripts/`. |
| `chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF` (Q4_K_M) | ~0.5 GB | verify first | llama.cpp, Qwen3.5, 262k ctx, 20 langs, Apache-2.0. ⚠️ ships `jev_score.cpp` / `readout_config.json` → may use a custom readout, not raw label logprobs. |
| `chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-GGUF` | ~1.3 GB | candidate | More accurate 2B sibling. |
| `Meanblock/JEV-CPU` (Qwen3-0.6B, MIT) | ~0.5 GB | candidate | `semantic-if`, CPU-tuned; needs GGUF conversion. |

Plan: keep Gemma-E4B as the accurate brain; a Q4_K_M requant now serves as the
fast **gate**. Only adopt the 0.8B model if its readout matches `jevify`'s
label-logprob path. Implemented: `scripts/setup-gate.sh` requantizes and serves
a second CPU instance on `:8082` (`-ngl 0`, 4 threads); `scripts/uninstall-gate.sh`
reverts it. Measured on this machine (same decisions, 90–210 tok states):
Q5 `:8081` 1770 ms / 4035 ms vs Q4 `:8082` 1098 ms / 2551 ms → **~1.6× faster**.

## 2. Prompt crafting — the real leverage

`jevify` renders `<state>JSON</state>` + `instructions` + `criteria`, then reads
the first answer token's logprobs. Rules:

1. Make it a **discrimination**, not an open question. "What should I do?" →
   `score` with ordered levels.
2. **Criteria descriptions carry the signal.** In `choice`, each
   `key — description` is in the prompt. Make them mutually exclusive and
   concrete; overlap splits probability mass and tanks confidence.
3. **2–5 options/levels.** 26/10 are allowed but calibration degrades.
4. **Define the boundary for `noul`** via `criteria {true,false}`. Biggest
   single accuracy lever.
5. **Fixed order, no shuffling** (position bias). For robustness, run reversed
   order and treat a flip as `review`.
6. **Structured, minimal state.** JSON with named fields beats a raw blob;
   strip ANSI, timestamps, repeated stack traces — every token costs prefill.
7. **One state, many questions** (`s1 ask`), not many states.
8. English, short clauses; keep thinking disabled (`no_think`).

Example (token-efficient, high-signal):

```
state: {"diff":"+ if (x) return;","task":"rename only"}
instructions: "Does this change runtime behavior beyond the stated task?"
criteria: {
  "true":  "Diff alters control flow, return values, or side effects.",
  "false": "Diff is a pure rename/format/comment change."
}
```

## 3. Per-context / session / project prompt improvements

- **Project profile** `.opencode/jev.json`: fixed option vocabularies, routing
  labels, default thresholds, domain aliases, optional `guide` string injected
  into the system prompt.
- **Global profile / guide**: `~/.config/opencode/jev/guide.md`.
- **Session ledger**: `~/.config/opencode/jev/sessions/<id>.json` — rolling,
  capped list of recent decisions for in-session consistency.
- **Agent-aware guidance**: inject the project guide only into primary agents.

## 4. Features that improve model output via prompting

- **`jev_prompt` tool** — turns a rough request into an optimal Jev prompt,
  explains the choices (`notes`), optionally executes it, and caches results.
- **`/jev` command** — one-liner entry to the tool.
- **Triggered `chat.message` intent hint** — heuristic detects vague prompts,
  then one batched `s1 ask` (choice task-kind + noul under-specified) appends a
  short `[jev-intent]` hint to the user turn. Gated + debounced so it does not
  cost ~1 s on every turn.
- **Guide injection** via `experimental.chat.system.transform`.
- **Self-consistency `verify`** (choice: reversed options; score: reversed
  levels) — a flip is reported as `review`.
- **Gate routing** — `gate:true` sends a call to `JEV_GATE_BASE_URL`.
- **Compaction preservation** via `experimental.session.compacting`.
- **Deterministic params** — `JEV_PARAMS=1` pins temperature ≤0.2 for
  judge/review/plan/compaction/test-gen.
- Roadmap: `score` rubric injection, DCP-style compaction triage.

## 5. Token optimisation

- Batch via `s1 ask` (shared prefill); keep states short.
- **Content-hash cache** `~/.cache/opencode/jev/<hash>.json`, keyed on
  `(mode, state, instructions, criteria, model, version)`.
- **Gate, don't spam**: hooks are awaited, so each call is real wall-clock.
- Zero output tokens is intrinsic to s1.
- Roadmap: use s1 to rank context before the expensive `local/planning`
  compaction call.

## 6. Project layout (v2, standalone)

This directory is the **canonical source**; `install.sh` symlinks it into
opencode so there is one source of truth.

```
src/jev.ts                           # server half: craft + verify + gate, system
                                     # guide, chat.message intent hint, s1 runner,
                                     # content-hash cache, session ledger,
                                     # project/global profiles, compaction
                                     # preservation, deterministic chat.params
tui.tsx                              # TUI half: registers the live prompt panel
lib/tui/                             #   config.ts, analyze.ts (heuristics),
                                     #   s1.ts (debounced model scoring),
                                     #   lexicon.ts (idx SQLite lexicon),
                                     #   suggest.ts (fragment matching),
                                     #   ste100.ts (ASD data), style.ts (STE rules),
                                     #   grammar.ts (safe grammar), panel.tsx
command/jev.md                       # /jev command
scripts/                             # CPU gate model (Q4_K_M) + systemd unit
  requant-q4.sh                      #   llama-quantize Q5_K_M -> Q4_K_M
  jev-gate-serve.sh                  #   llama-server on :8082 (-ngl 0, 4 threads)
  jev-gate.service                   #   systemd user unit
  setup-gate.sh                      #   requant + install + enable + health check
  uninstall-gate.sh                  #   disable + remove (keeps model file)
  config.example.json                #   template for ~/.config/opencode/jev/config.json
  tui-entry.mjs                      #   add/remove the tui.json plugin entry
  ste100-fetch.mjs                   #   download the private ASD Issue 9 dataset
tests/                                 # analyze/suggest/lexicon/style/grammar/ste100 + panel
dsh/dsh-hook.mjs                     # phase-2 scaffolding (deferred, unwired)
package.json                         # @opencode-ai/plugin + @opentui/{core,solid} deps
install.sh / uninstall.sh            # symlink install + tui.json entry management
```

Installed paths (symlinks into this repo, plus a TUI entry):

```
~/.config/opencode/plugins/jev.ts -> src/jev.ts
~/.config/opencode/command/jev.md -> command/jev.md
~/.config/opencode/tui.json        plugin += file://.../tui.tsx  (managed by install.sh)
```

It lives in the documented global auto-load directory
(`~/.config/opencode/plugins/`), so it needs **no** `plugin[]` entry. Do not also
list it in `plugin[]` or it will load twice and the `jev_prompt` tool will
register twice. Run `bun install` once so `@opencode-ai/plugin` resolves from the
repo's real path through the symlink.

Config precedence: **defaults < `~/.config/opencode/jev/config.json` < env <
plugin options**. Because an auto-loaded plugin never receives `plugin[]`
options, the persistent file is the practical way to configure it:

```json
{ "fast": false, "intentHint": true, "guide": true, "cache": true,
  "maxStateChars": 4000,
  "gateBaseUrl": "http://127.0.0.1:8082/v1", "gateModel": "jevify-gemma4-e4b" }
```

Env overrides: `JEV_FAST=1` use GPU, `JEV_INTENT=0`, `JEV_GUIDE=0`,
`JEV_CACHE=0`, `JEV_GATE_BASE_URL`, `JEV_GATE_MODEL`, `JEV_PARAMS=1`.

## 7. dsh (phase 2) — DEFERRED

Out of scope for this deliverable (opencode-only). Scaffolding is parked at
`dsh/dsh-hook.mjs` (Node ESM, dependency-free; SessionStart primer + debounced
UserPromptSubmit intent hint). When resumed: mount
`@deepseek-ai/dsh-hooks-claude-code` via an `insert:` entry in
`~/.dsh/profiles/<p>/cordis.patch.yml` (NOT `cordis.yml`), pointing at a
hooks.json; command hooks must emit
`{"hookSpecificOutput":{"hookEventName":"...","additionalContext":"..."}}`.

## 8. Live prompt panel (terminal TUI only)

As you type a prompt, a compact panel renders directly **below the input** with:

- a per-sentence colour (green/amber/red) and a live `score/100`;
- a status that shows `instant` (heuristic) then `classified` (after the
  debounced model pass);
- the top local suggestions (concrete target, criteria, specificity, …).

**Two-tier design** (s1 CPU latency is ~1 s, so per-keystroke model calls are
impossible):

1. **Instant heuristics** (`lib/tui/analyze.ts`) — `Intl.Segmenter` sentences,
   regex signals (vagueness, hedging, specificity, acceptance criteria,
   questions, all-caps). Runs on every keystroke, no model.
2. **Debounced s1** (`lib/tui/s1.ts`) — after `debounceMs` idle, one batched
   `s1 ask` over the sentences (gate endpoint by default), merged at 0.6 model /
   0.4 heuristic. Content-hash cached.

**How it attaches:** opencode's host renders the prompt through a slot
(`session_prompt`/`home_prompt`) in `mode:"replace"`. The plugin contributes a
renderer that renders `api.ui.Prompt` itself with its own ref (to read
`current.input`), puts `<LivePanel>` below it, and hands the ref back via
`props.ref` so draft/submit keep working.

**Loading:** `tui.json` `plugin` gets a `file://…/tui.tsx` entry (a file spec is
imported directly; no package install is needed). `install.sh` adds it
idempotently, preserving other entries; `uninstall.sh` removes it.

**Config** (`~/.config/opencode/jev/config.json`, `live` section):

```json
{ "live": { "enabled": true, "debounceMs": 700, "pollMs": 150,
            "minChars": 12, "maxChars": 800, "model": true,
            "suggest": true, "suggestMinChars": 2, "suggestLimit": 5,
            "suggestSources": "both", "mention": true, "suggestDebounceMs": 250,
            "acceptKey": "alt+s", "suggestNextKey": "alt+n",
            "suggestPrevKey": "alt+p",
            "style": true, "styleLimit": 6, "grammar": true, "grammarLimit": 6,
            "styleProfile": "ste", "steDictionary": "", "glossary": "",
            "steMaxInstructionWords": 20, "steMaxDescriptiveWords": 25,
            "steFlagUnknown": false,
            "gateBaseUrl": "http://127.0.0.1:8082/v1",
            "gateModel": "jevify-gemma4-e4b" } }
```

Env: `JEV_LIVE=0` disable, `JEV_SUGGEST=0` disable suggestions,
`JEV_MENTION=0` disable `@`-mentions, `JEV_CONTEXT=0` disable the content-index
source, `JEV_STYLE=0` disable STE checks,
`JEV_GRAMMAR=0` disable grammar, `JEV_STE_DICT` / `JEV_GLOSSARY` data paths,
`JEV_STE_UNKNOWN=1` flag unknown words, plus `JEV_GATE_BASE_URL` /
`JEV_GATE_MODEL`. Debug: `JEV_TUI_DEBUG=1` (stderr traces),
`JEV_TUI_SELFTEST=1` (render a fixture below the prompt without typing). Any
key may be set to `""` to disable that binding.

**Project-context autosuggest:** a model-free source with two feeds — the idx
lexicon (`lib/tui/lexicon.ts`, a direct read-only `bun:sqlite` open of
`<worktree>/.indexer-cli/db.sqlite`; never spawn `idx`, which costs 10–54 s and
takes a lock) and a debounced `api.client.find.symbols`/`find.files` query
(`suggestSources`: `idx` | `server` | `both`). `lib/tui/suggest.ts` ranks
candidates by prefix → camelCase initialism → subsequence → substring → typo
tolerance (edit distance 1), boosting files in git status and identifiers seen
earlier in the session; a prebuilt index (WeakMap-cached, binary-searched) keeps
it per-keystroke. A trailing `@` switches to file-mention mode. There is no
cursor API, so the end of the draft is the implicit cursor. `acceptKey` /
`suggestNextKey` / `suggestPrevKey` rewrite/cycle the fragment via
`TuiPromptRef.set`. Absent or unfinished indexes (`status` not in
`completed`/`ready`) are ignored gracefully.

**Writing checks (ASD-STE100 + grammar):** `lib/tui/style.ts` is a TypeScript
port of the 53 Issue 9 rules plus GR-1..8, driven by `lib/tui/ste100.ts`. The
data layer loads the full ASD Issue 9 dataset (876 approved / 1,319
non-approved words) from `~/.config/opencode/jev/ste100/dictionary.json`, plus a
`glossary.txt`. `scripts/ste100-fetch.mjs` downloads the dataset into that
private dir; it is **never committed** because the ASD text is copyright. A tiny
in-repo seed keeps the checker usable with no dataset. Mechanical rules carry a
`replacement` (accept splices it into the issue span); judgement rules are
advisory notes. `lib/tui/grammar.ts` adds a high-confidence general tier
(repeated words, `its'`, `then`/`than`, `affect`/`effect`, `a`/`an`, sentence
case, double spaces, unmatched brackets/quotes, a small misspelling table).
Findings merge ahead of completions in the same list, capped per source.
`RULE_COVERAGE` marks each rule auto / advisory / manual, and
`tests/style.test.ts` asserts every one of the 53 rule ids is accounted for
(spot-checks: 1.1 and 4.2 auto; 5.1 advisory).

**Crash-safety:** the panel render path is total (no non-null assertions — the
old `state()!.tips` reads crashed the TUI when the draft was typed then
cleared) and is wrapped in a Solid `<ErrorBoundary>` so a fault degrades to
"no panel" instead of taking down opencode.

**Desktop/web is intentionally excluded.** The `@opentui/solid` slot API is
terminal-TUI only; the Electron/web UI would need a separate DOM-injection route
and is not implemented here.

## 9. Content index + multilanguage (v2.1)

**Motivation.** The lexicon answers "what symbol am I typing?" but not "which
code owns what I am asking for?". Typing a rough `update payment` produced
nothing useful — the FTS half of the idx index was unused, and everything
(tokenizing, `SPECIFIC`, the writing checks) assumed English.

**Findings from the real index** (DukaLiteFull, snapshot `f2e9f705` ready, 1265
files, `language_id` ∈ python/document/typescript):

- `code_search_fts` is a full-text index of file *contents*. `file_path` holds
  the **slug** (`src/a.ts src a ts`) while `source_path` holds the clean path;
  `primary_symbol` holds `Name name in words`. Both slug forms are stripped
  before anything is shown (`lib/tui/content.ts` `cleanFile`/`cleanSymbol`).
- `symbols.kind` is **TEXT** in idx v2 ('function', 'class', …); the lexicon
  used to coerce every kind to `0`, so `symbolKindLabel` rendered "" for every
  real symbol. Numeric (idx v1 LSP) kinds still pass through.
- Timing: one FTS `MATCH` 11 ms cold / 0.5 ms warm; a whole content search
  (≈2 keywords + enrichment) 6–12 ms — cheap enough for the keystroke path.
- `unicode61 remove_diacritics 2` must be mirrored exactly: fold only Latin
  accents (blanket NFKD breaks `платежей` and `결제`), and a CJK run is one
  token, hence the `LIKE` substring probe for bigrams.

**Design.**

- `lib/tui/keywords.ts` (pure) — Unicode tokenization → folded parts (camelCase,
  `_`, `-`, `/` splits) → stopword/generic-action/extension filtering, plus
  position-weighted ranking and the whole `snake_case` form kept as an FTS
  phrase. The stop list is English plus the function words of es/pt/fr/de/it/nl,
  so a request in another language does not burn its keyword slots on `el`, `le`
  or `der` ("arreglar el reembolso de pagos" → `arreglar, reembolso, pagos`).
  CJK runs become bigrams; `splitByScript` routes terms to FTS or `LIKE`.
- `lib/tui/content.ts` — one `MATCH` per spaced keyword + a bounded `LIKE` per
  packed keyword, grouped by file (`score = keywords × 1000 − |rank|`), then a
  single `IN (…)` enrichment query for symbols + `files.language_id`. Cached
  handle (60 s, keyed by mtime), `tableExists` guard, every SQL call in
  try/catch, `[]` on any failure.
- `lib/tui/context.ts` (pure) — `contextSuggestions()` emits the `sharpen:`
  whole-draft rewrite (new `Suggestion.replaceAll`) and one append-only hit per
  file; `draftPrompt()` keeps the user's wording and appends
  `Target:` / `Symbols:` lines.
- `lib/tui/script.ts` — dominant script of the draft; non-Latin drafts skip the
  English-only grammar/STE tiers instead of drowning the user in false flags.
- `tui.tsx` — debounced content pass (own timer, `contextSources` auto/always/off)
  and `append`/`replaceAll` acceptance in `acceptSuggestion`.
- `src/jev.ts` — `jev_context` tool: the same search server-side, returning
  targets + a drafted prompt + notes. Also imports the shared `lib/tui/*`
  readers (runtime-agnostic, no plugin SDK types), so TUI and server never drift.

**Multilanguage polish.** `analyze.ts` `SPECIFIC` accepts Unicode
paths/filenames/identifiers/CJK words; `suggest.ts` fragment/mention regexes use
`\p{L}`/`\p{N}` (ASCII behaviour unchanged — `\p{Han}` is NOT supported by Bun
1.4.2, use `\p{Script=Han}`); `isVague` keeps its English heuristics but now
recognises targets in any script (`\p{Script=…}`, `snake_case`, digits,
`@mention`), which strictly *reduces* false positives.

**Result (measured, DukaLiteFull).** `searchContent("update payment for momo")`
→ 6.3 ms, hits `sales_core/payment.py:230 checkout_payment`,
`sync/apply/sales.py:349 _apply_momo_transaction`,
`reports/reports.py:119 get_payment_method_breakdown`,
`tests/test_payment_methods.py _reset_payment_settings` — i.e. the four places
that own payment logic, found from a 23-character prompt.

## 10. s1 wiring hardening (v2.1.1)

The plugin is only useful if the classifier answers, and the default install
(state of this machine: `s1-cpu.service` and `jev-gate.service` enabled but
**inactive**) degraded into silent `s1 error:` strings. Fixed on two sides.

**Bring-up.** `systemctl --user start s1-cpu` (:8081, Q5_K_M) and
`scripts/setup-gate.sh`'s unit (:8082, Q4_K_M). Measured on this machine
(12 cores, load avg ~16 from other LLM work):

| call | CPU :8081 | gate :8082 |
|---|---|---|
| single `noul`, warm | 3.6 s | 1.3 s |
| intent `ask` (2 questions, 155 tok state) | 16.2 s | 3.4 s |
| first call after `systemctl start` | 11.3 s, then `503 Loading model` | ~25 s model load |
| panel scoring, 5 sentences | – | 16.9 s |

Prefill is the cost (~18 ms/token on the CPU server), so the intent questions
were made terse (`INTENT_QUESTIONS` criteria shortened: 257 → 155 input tokens).
Answer quality was checked to be route-independent: gate vs CPU agree on
P(vague) within 0.01–0.03 across four prompts.

**Code** (`src/jev.ts`, `lib/tui/s1.ts`):

- interactive hooks (the intent hint) prefer the gate and **fall back** to the
  resident route when the endpoint refuses a connection; the refusal is
  remembered for 5 min, so the probe costs ~1 ms once;
- `gate: true` in `jev_prompt` does *not* fall back — it reports the failure
  with the command that fixes it (`hintFor`);
- every s1 call is bounded (`JEV_S1_TIMEOUT_MS`, 30 s default, child killed) and
  retried once on `503 Loading model`; failures are never cached;
- `JEV_S1_BIN` selects the CLI binary (server plugin, and `lib/tui/s1.ts`);
- the cache key now includes the route, so a CPU answer can never be replayed
  for a gate request (they were colliding before);
- the TUI panel's call budget grows with the number of sentences scored;
- `craft()` tolerates an omitted `kind` (defensive: the tool schema default is
  normally applied by the runtime).

**Tests** (`tests/jevs1.test.ts`, 8 cases, no model): fake `s1` binary on disk
records argv, so the tests assert the route flags (`--cpu` vs `--base-url …`),
the cache hit path, the gate→CPU fallback via the `chat.message` hook, the
timeout kill, and each actionable error hint.

## Verification

- `bun build ~/.config/opencode/plugins/jev.ts --target=bun` (syntax/imports).
- Server plugin: `bun build src/jev.ts --target=bun`; TUI half:
  `bun build tui.tsx --target=bun --packages external` (optional platform deps
  make a plain build fail — use `--packages external`).
- `bun test tests` (135 pass / 397 expects: heuristics, suggest matching and the
  accept paths, idx lexicon against a temp SQLite fixture, keyword extraction,
  content search against an FTS fixture, target/draft building, script
  detection, STE rule engine with the 53-rule coverage assertion, grammar,
  STE data loader, a panel render/transition test, and the s1 wiring tests
  against a fake `s1` binary).
- STE data: `node scripts/ste100-fetch.mjs` (downloads the private ASD dataset
  into `~/.config/opencode/jev/ste100/`; never committed — ASD copyright).
- `s1 doctor --cpu` (endpoint + model + card example) — the first thing to run
  when the plugin reports `cannot reach http://127.0.0.1:8081/v1`.
- Gate: `scripts/setup-gate.sh` then `s1 noul --base-url http://127.0.0.1:8082/v1
  --model jevify-gemma4-e4b --state ... --question ...`.
- TUI live panel: `JEV_TUI_SELFTEST=1 JEV_TUI_DEBUG=1 script -qec "timeout 12
  opencode --print-logs --log-level INFO" /tmp/opencode/jev.log` — expect
  `[jev-tui] plugin loaded` / `slots registered id=jev-prompt-assist` and the
  panel below the prompt.
- **Restart opencode** after changing the plugin/command/tui.json/config (read once).
- Manual: `/jev <rough question>` then confirm the crafted prompt + calibrated result.
