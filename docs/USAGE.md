# jev-prompt-assist — usage and dependencies

Everything the plugin does runs locally: the classifier is a GGUF on your own
machine, the index is the `idx` SQLite database in your worktree, and nothing is
uploaded. This document is the long-form companion to `README.md` (overview) and
`PLAN.md` (design history).

```
opencode session
  ├─ server plugin  src/jev.ts        tools jev_prompt / jev_context, hooks
  └─ TUI half       tui.tsx           live panel + suggestions (opentui)
        └─ lib/tui/*                  pure readers/rankers, shared by both
             ├─ s1.ts                 spawns the `s1` CLI (gate endpoint)
             ├─ content.ts            searches the idx content index (read-only)
             └─ lexicon.ts            reads the idx symbol table (read-only)
```

---

## 1. Dependencies

| Dependency | Needed for | How to check | Install |
|---|---|---|---|
| `bun` ≥ 1.4 | running the plugin, tests, bundling | `bun --version` | <https://bun.sh> (`curl -fsSL https://bun.sh/install \| bash`) |
| `node` ≥ 20 | only used by `install.sh` when `bun` is absent | `node --version` | distro package |
| opencode with plugin **and** TUI support | loading `plugins/jev.ts` + `tui.json` | `opencode --version` | <https://opencode.ai> |
| `@opencode-ai/plugin`, `@opentui/solid` | resolved types/imports | `ls node_modules/@opencode-ai/plugin` | `bun install` in the repo |
| `s1` CLI (s1-adapter) | every calibrated decision | `s1 --version` | see §3 |
| `llama-server` (llama.cpp) | serving the classifier | `/home/kr/llama.cpp/build/bin/llama-server --version` | build llama.cpp |
| Jevified Gemma-4-E4B GGUF (Q5_K_M, optional Q4_K_M) | the model weights | `ls /home/kr/Models/active/jevify-gemma4-e4b*.gguf` | <https://huggingface.co/kushalpatil/jevify-gemma4-e4b> |
| `idx` (indexer-cli) + an index in the worktree | `jev_context`, content suggestions, symbol completion | `ls <worktree>/.indexer-cli/db.sqlite` | your idx install; `idx index` |
| systemd user units | keeping the model resident | `systemctl --user is-active s1-cpu` | shipped unit files (§3) |

SQLite needs no install: the readers use Bun's built-in `bun:sqlite` and open the
index **read-only**.

Optional:

- `llama-swap` (`:8080`) — only for the GPU route (`JEV_FAST=1`, `gate`/`fast`
  tool args). It swaps the resident model, so prefer the CPU routes.
- The ASD-STE100 dictionary — only for the style tier: `node scripts/ste100-fetch.mjs`
  writes it to `~/.config/opencode/jev/ste100/` (dataset is copyright ASD, never
  committed).

---

## 2. Install / update / remove

```sh
git clone <this repo> && cd jev-prompt-assist
bun install          # @opencode-ai/plugin + @opentui/*
./install.sh         # symlinks plugin, command and the TUI entry
./uninstall.sh       # removes the links (keeps your config/cache)
```

`install.sh` creates:

| target | source |
|---|---|
| `~/.config/opencode/plugins/jev.ts` | `src/jev.ts` (symlink) |
| `~/.config/opencode/command/jev.md` | `command/jev.md` (symlink) |
| `~/.config/opencode/tui.json` entry `file://<repo>/tui.tsx` | `tui.tsx` (imported directly) |

`OPENCODE_CONFIG_DIR` overrides `~/.config/opencode`. **Restart opencode** after
installing, after editing any of those files, and after changing
`~/.config/opencode/jev/config.json` — config is read once at load.

Verify:

```sh
bun test tests                                   # must be all green
bun build src/jev.ts --target=bun                # syntax/imports gate
JEV_TUI_SELFTEST=1 opencode                      # panel renders a fixture
```

---

## 3. Wiring the s1 model (do this first)

The plugin shells out to the `s1` CLI, which talks to an OpenAI-compatible
server. Three routes exist:

| route | endpoint | model | used by | typical latency (measured, load avg ~16) |
|---|---|---|---|---|
| CPU | `http://127.0.0.1:8081/v1` | Q5_K_M, `-ngl 0` | `jev_prompt` default, TUI fallback | ~3.6 s warm noul, ~16 s batched `ask` |
| Gate | `http://127.0.0.1:8082/v1` | Q4_K_M, `-ngl 0` | intent hint (default), `gate: true`, TUI panel | ~1.3 s warm noul, ~3.4 s intent `ask` |
| GPU | `http://127.0.0.1:8080/v1` | llama-swap | `fast: true` / `JEV_FAST=1` | ~75 ms warm, but evicts your coding model |

The gate and the CPU server agree closely on the intent questions (measured
differences ≤ 0.03 in P(vague)), so the gate is the default for anything that
runs per message.

### 3.1 Start the CPU classifier

```sh
systemctl --user enable --now s1-cpu.service     # unit from s1-adapter
systemctl --user status s1-cpu
s1 doctor --cpu          # endpoint reachable, alias present, card example
```

If the unit does not exist, install the adapter first:

```sh
cd ~/.local/share/s1-adapter && uv sync && uv tool install --editable .
```

### 3.2 (Optional) Start the lightweight gate

```sh
scripts/setup-gate.sh        # requant Q5→Q4, install unit, health check, config
scripts/uninstall-gate.sh    # reversible
```

Without the gate, nothing breaks: the intent hint probes the endpoint (≈1 ms
when refused), remembers it for 5 minutes and runs on the CPU server instead.
To point elsewhere, set `gateBaseUrl`/`gateModel` in the config file or
`JEV_GATE_BASE_URL`/`JEV_GATE_MODEL` in the environment.

### 3.3 What the plugin does when the model is not there

Every s1 call is:

- **bounded** — `JEV_S1_TIMEOUT_MS` (default 30 s), child killed on expiry;
- **retried once** when llama-server answers `503 Loading model` (right after
  `systemctl --user start`);
- **never cached** when it fails;
- **reported with a fix**, e.g.

```
s1 error: s1: error: cannot reach http://127.0.0.1:8081/v1 — … Connection refused
  — start the CPU classifier (`systemctl --user start s1-cpu`).
    Verify with `s1 doctor --cpu`.
```

or, for a missing binary, the install command and the `JEV_S1_BIN` override.

---

## 4. Server tools

Both tools are exposed to the agent and appear as `jev_*` in the tool list.

### 4.1 `jev_prompt` — craft (and optionally run) a classifier question

| arg | type | default | notes |
|---|---|---|---|
| `task` | string | – | what you want decided, plain language |
| `state` | string | – | the artifact judged (diff, log, ticket) |
| `kind` | `auto\|noul\|choice\|score` | `auto` | `auto` picks from `options`/`levels` |
| `options` | string[] | – | `key` or `key=description` for `choice` (2–5) |
| `levels` | string[] | – | ordered `low → high` for `score` (2–5) |
| `trueCriterion` / `falseCriterion` | string | – | the yes/no boundary (biggest accuracy lever) |
| `threshold` | number | – | adds `action: act\|review` per answer (0.85 recommended) |
| `verify` | bool | `false` | re-runs with the answer space reversed; flags order-sensitive results |
| `gate` | bool | `false` | run on the gate endpoint when configured |
| `run` | bool | `false` | **false** = craft only (dry run) |
| `save` | bool | `true` | record the decision in the session ledger |

```
jev_prompt { task: "Merge risk of this change", state: "<diff>",
             kind: "score", levels: ["low","medium","high"],
             threshold: 0.85, run: true }
```

Output: the crafted prompt (mode, instructions, criteria, craft notes), then
`result:` with the calibrated answer, `latency_ms:` and `route:` (the route the
answer came from — `cpu`, `gpu` or `gate <url>`), then `verify:` when asked.

### 4.2 `jev_context` — rough request → concrete targets

| arg | type | default | notes |
|---|---|---|---|
| `task` | string | – | the rough request, any language |
| `worktree` | string | session directory | any directory with an idx index |
| `limit` | number | 6 (1–20) | max hits |
| `detail` | bool | `true` | attach language, signature, doc comment |
| `draft` | bool | `true` | include the drafted prompt |
| `maxFiles` | number | 3 (1–10) | files named in the drafted `Target:` line |
| `criteria` | string | – | appended as a `Criteria:` line |

```
JEV CONTEXT — update payment for momo
worktree: /home/kr/Projects/DukaSystems/DukaLiteFull
keywords: payment, momo

targets (4):
1. dukalite-desktop/dukalite/modules/sales_core/payment.py:230 — checkout_payment (python, +12 more)
   def checkout_payment(provider: str, amount_cents: int) -> PaymentResult
   excerpt: … «payment» intent written before the child transaction …
   matched: payment
2. …
notes:
  - Short request — attach acceptance criteria so the work can be verified.

drafted prompt:
update payment for momo
Target: dukalite-desktop/tests/test_payment_methods.py, …/sales.py, …/payment.py
Symbols: _reset_payment_settings, _apply_momo_transaction (sales.py:349), checkout_payment (payment.py:230)
```

Notes tell you when the index is missing (`idx index`), when nothing matched,
when only one keyword matched, when a single file dominates, which languages the
targets are in, and when the request is too short to verify.

No index? The tool still returns the keywords and the guidance, with the note
that tells you how to build the index.

---

## 5. Terminal TUI (live prompt panel)

The panel replaces the prompt input area and shows, while you type:

- **instant clarity score** per sentence (heuristic), refined by the classifier
  when `live.model` is on (debounced `live.debounceMs`);
- **suggestions** — symbols and paths from the idx lexicon and the opencode find
  API, filtered by the fragment after your cursor (Unicode-aware);
- **style/grammar findings** (ASD-STE100 + a safe grammar tier);
- **content targets** — files and functions the draft talks about, from the idx
  content index, plus a `sharpen:` rewrite that pins them.

Keys (configurable):

| key | command | effect |
|---|---|---|
| `alt+s` | `jev.acceptSuggestion` | accept the selected suggestion |
| `alt+n` | `jev.nextSuggestion` | next candidate |
| `alt+p` | `jev.prevSuggestion` | previous candidate |

A suggestion is applied according to its kind: a style fix replaces its span, a
completion replaces the trailing fragment, a target is appended after the draft,
and `sharpen:` rewrites the whole draft.

Debug:

```sh
JEV_TUI_SELFTEST=1 opencode      # render the fixture panel without typing
JEV_TUI_DEBUG=1 opencode 2>trace # plugin/slot/poll traces on stderr
```

---

## 6. Multilanguage drafts

- Keyword extraction understands Unicode letters/digits, folds diacritics the
  way SQLite does (`café` → `cafe`, but Cyrillic and Hangul are never
  decomposed), splits `camelCase`, `snake_case`, `kebab-case`, and drops English,
  Spanish, Portuguese, French, German, Italian and Nordic function words.
- CJK runs are matched by bigram `LIKE` probes (FTS5 treats an unbroken run as
  one token); Korean is space-separated and matches directly.
- Completions and the vague-prompt heuristic accept non-Latin identifiers and
  words; a Korean or Japanese prompt is no longer flagged as bad English.
- `jev_context` works in any language, e.g. `改善支払い処理` (matched by bigram
  probes on the CJK run) or `결제 모듈을 수정해 주세요`.
- Hit details carry the file language, and the notes list the languages present.

- Hit details carry the file language, and the notes list the languages present.

---

## 7. Configuration reference

File: `~/.config/opencode/jev/config.json` (template
`scripts/config.example.json`). Precedence **defaults < file < env < plugin
options**.

### Server plugin

| key | env | default | meaning |
|---|---|---|---|
| `fast` | `JEV_FAST=1` | `false` | use the GPU route instead of CPU |
| `intentHint` | `JEV_INTENT=0` | `true` | append the `[jev-intent]` hint to vague messages |
| `guide` | `JEV_GUIDE=0` | `true` | inject the project guide into the system prompt |
| `cache` | `JEV_CACHE=0` | `true` | content-hash cache of s1 results |
| `maxStateChars` | – | `4000` | state truncation for classifier calls |
| `gateBaseUrl` | `JEV_GATE_BASE_URL` | `http://127.0.0.1:8082/v1` | gate endpoint |
| `gateModel` | `JEV_GATE_MODEL` | `jevify-gemma4-e4b` | gate alias (empty on the server side means "the s1 CLI default") |
| – | `JEV_S1_BIN` | `s1` | s1 binary path/name |
| – | `JEV_S1_TIMEOUT_MS` | `30000` | per-call budget |
| – | `JEV_PARAMS=1` | off | pin temperature ≤0.2 for judge/review/plan/compaction/test-gen |

Guides: `<project>/.opencode/jev.json` → `{ "guide": "..." }`, or global
`~/.config/opencode/jev/guide.md`.

### TUI panel (`live` section)

```json
{
  "live": {
    "enabled": true, "debounceMs": 700, "pollMs": 150,
    "minChars": 12, "maxChars": 800, "model": true,
    "suggest": true, "suggestMinChars": 2, "suggestLimit": 5,
    "suggestSources": "both", "mention": true, "suggestDebounceMs": 250,
    "acceptKey": "alt+s", "suggestNextKey": "alt+n", "suggestPrevKey": "alt+p",
    "style": true, "grammar": true, "styleLimit": 6, "grammarLimit": 6,
    "steMaxInstructionWords": 20, "steMaxDescriptiveWords": 25,
    "steFlagUnknown": false, "steDictionary": "", "glossary": "",
    "context": true, "contextMinChars": 10, "contextLimit": 4,
    "contextDebounceMs": 400, "contextSources": "auto"
  }
}
```

`JEV_LIVE=0`, `JEV_SUGGEST=0`, `JEV_MENTION=0`, `JEV_STYLE=0`, `JEV_GRAMMAR=0`,
`JEV_CONTEXT=0` disable individual tiers; `JEV_STE_DICT` / `JEV_GLOSSARY`
override the dictionary paths; `JEV_STE_UNKNOWN=1` also flags unknown words.

### `s1` CLI env (set by your model server, not the plugin)

| var | default | meaning |
|---|---|---|
| `S1_BASE_URL` | `http://127.0.0.1:8080/v1` | llama-swap endpoint |
| `S1_CPU_BASE_URL` | `http://127.0.0.1:8081/v1` | resident CPU server |
| `S1_MODEL` | `jevify-gemma4-e4b` | alias |
| `S1_RUNTIME` | `llamacpp` | request dialect |
| `S1_API_KEY` | `local` | bearer token |
| `S1_THRESHOLD` | – | default confidence gate |

---

## 8. Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `s1 error: … cannot reach http://127.0.0.1:8081/v1` | CPU classifier not running | `systemctl --user start s1-cpu`; `s1 doctor --cpu` |
| `… cannot reach http://127.0.0.1:8082/v1` | gate down (auto-fallback for the intent hint) | `systemctl --user start jev-gate`, or `scripts/setup-gate.sh`, or set `gateBaseUrl: ""` |
| `s1: error: … 503 Loading model` | model still mmap-ing | wait; the plugin retries once, then reports readiness via `s1 doctor` |
| `timed out after N ms` | server too slow for the budget | raise `JEV_S1_TIMEOUT_MS`, or shorten the state, or use the gate |
| `Executable not found in $PATH: "s1"` | s1 CLI not installed | `uv tool install s1-adapter`, or `JEV_S1_BIN=/path/to/s1` |
| intent hint never appears | disabled / cooldown / not vague | `JEV_INTENT=1`; 20 s per-session cooldown; the heuristic must fire first |
| `targets (0)` or `No idx content index` | no index in the worktree | `idx index` in that directory, or pass `worktree:` |
| context hits are stale | index older than the code | `idx index` (readers re-open on mtime change, 60 s TTL) |
| no panel / no suggestions | TUI entry or live config | `JEV_TUI_SELFTEST=1`; keys `alt+s`/`alt+n`; check `JEV_LIVE`, `JEV_SUGGEST` |
| `bun build tui.tsx` fails | `@opentui/core` per-platform optional deps | use `--packages external`; opencode loads `tui.tsx` itself |

---

## 9. Privacy, cost and limits

- Everything runs locally; the only network calls are to `127.0.0.1`.
- The index is opened **read-only**; the readers never write to your worktree.
- Prefill dominates CPU latency, so keep classifier states short and batch
  questions with `s1 ask` (one shared prefix).
- The classifier is calibrated on average, not per task; treat `action: act` as
  one input to a decision you own, and gate only reversible actions on it.
- Cache: `~/.cache/opencode/jev/` (content-hashed s1 results, keyed by mode,
  state, question, threshold **and route**). Session ledger:
  `~/.config/opencode/jev/sessions/`.
