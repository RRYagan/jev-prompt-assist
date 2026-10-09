---
description: Craft an optimal Jev/System-1 prompt from a rough request and optionally run it locally (calibrated probability, CPU, zero output tokens).
agent: build
---

Turn the request below into an optimal Jev (`s1`) classifier prompt, then act on the result.

Request: $ARGUMENTS

Steps:
1. Gather the artifact under judgment from the conversation (a diff, test log, ticket, plan, or JSON). If it is not present, ask for it and stop.
2. When the request is about code and names no concrete target (no file, symbol, or error), call the `jev_context` tool with the request text; use the `Target:`/`Symbols:` lines it returns to name that code.
3. Call the `jev_prompt` tool:
   - `task` = what the user wants to decide, phrased as a plain yes/no statement or a clear rating goal.
   - `state` = the artifact (keep it short; strip noise, paths, timestamps, ANSI).
   - `kind` = the literal mode the user asked for, else `auto`.
   - pass `options` (choice) or `levels` (score) only when they are obvious from the request; otherwise let the tool build a `noul`.
   - set `run: true` and `threshold: 0.85` unless the user specified otherwise.
   - set `verify: true` when the decision is `choice` or `score` and worth a second pass (reverses option/level order and flags order-sensitive flips); it roughly doubles latency.
   - set `gate: true` to run on the lightweight Q4 gate endpoint (`JEV_GATE_BASE_URL`, default `:8082`) instead of the main CPU model.
4. Report, in order:
   - the crafted prompt (the tool returns it),
   - the calibrated result,
   - `action: act` when confidence ≥ threshold, else `action: review`,
   - the `verify:` line when `verify` was used.
5. Never invent probabilities or reinterpret the numbers; report them verbatim.
