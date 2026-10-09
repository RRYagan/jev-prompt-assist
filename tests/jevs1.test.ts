import { afterAll, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The s1 wiring (argv, cache, timeout, error hints, gate fallback) is exercised
// against a fake `s1` binary: no model, no network, deterministic. JEV_S1_BIN /
// JEV_S1_TIMEOUT_MS / JEV_CACHE are read per plugin instance, and JEV_S1_BIN is
// also read at module load, so it is set before the first import. Cache writes
// are disabled by default to keep the real cache dir untouched.

// Unique per run: the plugin's content-hash cache lives in the user's real
// cache dir, so a state that was cached by an earlier run (or by a live call)
// would short-circuit the fake s1 binary.
const RUN = Math.random().toString(36).slice(2, 8)
const SANDBOX = mkdtempSync(join(tmpdir(), "jev-s1-"))
const ARGV_LOG = join(SANDBOX, "argv.log")

function installFake(name: string, body: string): string {
  const path = join(SANDBOX, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

// Records argv (one line per call) and answers a noul.
installFake(
  "s1-ok",
  `
printf '%s\\n' "$*" >> "${ARGV_LOG}"
echo '{"model":"fake","answers":{"answer":{"type":"noul","noul":0.91}},"latency_ms":12}'
`,
)

// Always refuses, like an endpoint that is not running.
installFake(
  "s1-fail",
  `
cat > /dev/null
echo "s1: error: cannot reach http://127.0.0.1:8081/v1 — is llama-swap (or s1-cpu) running? ([Errno 111] Connection refused)" >&2
exit 2
`,
)

// Refuses only when an explicit --base-url is passed (i.e. the gate), and
// answers otherwise: models "gate down, resident route fine".
installFake(
  "s1-route",
  `
printf '%s\\n' "$*" >> "${ARGV_LOG}"
for arg in "$@"; do
  if [ "$arg" = "--base-url" ]; then
    cat > /dev/null
    echo "s1: error: cannot reach http://127.0.0.1:8082/v1 — is llama-swap (or s1-cpu) running? ([Errno 111] Connection refused)" >&2
    exit 2
  fi
done
cat > /dev/null
echo '{"model":"fake","answers":{"kind":{"type":"choice","choice":"debug","probabilities":{"debug":0.7,"other":0.3},"confidence":0.61},"vague":{"type":"noul","noul":0.87}},"latency_ms":12}'
`,
)

// Hangs: killed by the plugin's call budget.
installFake("s1-slow", "exec sleep 30")

process.env.JEV_S1_TIMEOUT_MS = "900"
process.env.JEV_GATE_BASE_URL = "http://127.0.0.1:8082/v1"

type PluginInstance = {
  tool: Record<string, { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }>
  "chat.message": (input: unknown, output: { parts: { type: string; text: string }[] }) => Promise<void>
}

async function load(fake: string, tag: string, cache = false): Promise<PluginInstance> {
  process.env.JEV_S1_BIN = join(SANDBOX, fake)
  process.env.JEV_CACHE = cache ? "1" : "0"
  const mod = (await import(`../src/jev?s1test=${tag}`)) as { default: unknown }
  const factory = mod.default as (input: unknown) => Promise<PluginInstance>
  return factory({ directory: SANDBOX })
}

function argv(): string[] {
  return readFileSync(ARGV_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
}

const SESSION = { sessionID: "s1-wiring" }

afterAll(() => {
  process.env.JEV_CACHE = "0"
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe("jev_prompt s1 wiring", () => {
  it("spawns s1 on the cpu route and reports the answer", async () => {
    const instance = await load("s1-ok", "cpu")
    const out = await instance.tool.jev_prompt!.execute(
      { kind: "noul", task: "Does this request name a concrete target", state: `wire-check one ${RUN}`, run: true, save: false },
      SESSION,
    )
    expect(out).toContain("route: cpu")
    expect(out).toContain('"noul":0.91')
  }, 20_000)

  it("passes --cpu, --state - and the question to the s1 CLI", async () => {
    const last = argv().pop()!
    expect(last).toContain("noul")
    expect(last).toContain("--cpu")
    expect(last).toContain("--state")
    expect(last).toContain("--question")
  })

  it("targets the gate endpoint when gate: true", async () => {
    const instance = await load("s1-route", "gate")
    await instance.tool.jev_prompt!.execute(
      { kind: "noul", task: "gate check", state: `wire-check gate argv ${RUN}`, run: true, gate: true, save: false },
      SESSION,
    )
    const last = argv().pop()!
    expect(last).toContain("--base-url")
    expect(last).toContain("http://127.0.0.1:8082/v1")
  }, 20_000)

  it("serves a repeated identical request from the cache", async () => {
    const instance = await load("s1-ok", "cache", true)
    const args = { kind: "noul", task: "cache check", state: `wire-check cache ${RUN}`, run: true, save: false }
    const first = await instance.tool.jev_prompt!.execute(args, SESSION)
    const before = argv().length
    const second = await instance.tool.jev_prompt!.execute(args, SESSION)
    expect(first).not.toContain("(cached)")
    expect(second).toContain("(cached)")
    expect(argv().length).toBe(before)
  }, 20_000)
})

describe("s1 failure reporting", () => {
  it("names the server command for an unreachable cpu route", async () => {
    const instance = await load("s1-fail", "fail")
    const out = await instance.tool.jev_prompt!.execute(
      { kind: "noul", task: "t", state: `wire-check failure ${RUN}`, run: true, save: false },
      SESSION,
    )
    expect(out).toContain("s1 error")
    expect(out).toContain("systemctl --user start s1-cpu")
    expect(out).toContain("s1 doctor --cpu")
  }, 20_000)

  it("names the gate script when the gate endpoint is down", async () => {
    const instance = await load("s1-fail", "gatefail")
    const out = await instance.tool.jev_prompt!.execute(
      { kind: "noul", task: "t", state: `wire-check gate down ${RUN}`, run: true, gate: true, save: false },
      SESSION,
    )
    expect(out).toContain("scripts/jev-gate-serve.sh")
    expect(out).toContain("s1 doctor --base-url http://127.0.0.1:8082/v1")
  }, 20_000)

  it("bounds a hung s1 call instead of stalling the hook", async () => {
    const instance = await load("s1-slow", "slow")
    const started = Date.now()
    const out = await instance.tool.jev_prompt!.execute(
      { kind: "noul", task: "t", state: `wire-check timeout ${RUN}`, run: true, save: false },
      SESSION,
    )
    expect(Date.now() - started).toBeLessThan(9000)
    expect(out).toContain("timed out after 900 ms")
    expect(out).toContain("route cpu")
  }, 20_000)
})

describe("intent hint", () => {
  it("falls back to the resident route when the gate is unreachable", async () => {
    const instance = await load("s1-route", "intent")
    const parts = [{ type: "text", text: `fix the payment thing ${RUN}` }]
    await instance["chat.message"]({ sessionID: "s1-hint", agent: "build" }, { parts })
    expect(parts[0].text).toContain("[jev-intent]")
    expect(parts[0].text).toContain("under-specified")
    // the call that produced the hint must be the resident route, not the gate
    expect(argv().pop()!).not.toContain("--base-url")
  }, 20_000)
})
