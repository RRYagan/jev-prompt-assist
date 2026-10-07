#!/usr/bin/env bash
# Serve the lightweight Jev gate classifier as a CPU-only OpenAI-compatible
# endpoint (default http://127.0.0.1:8082/v1), independent of the main resident
# classifier on :8081.
#
# Gate calls are short (<= ~1500 chars) and only back cheap interactive hooks
# (intent hints), so the context is small and the thread count deliberately
# leaves headroom for the main server.
#
# Overrides: JEV_GATE_MODEL_PATH, JEV_GATE_PORT, JEV_GATE_CTX, JEV_GATE_THREADS,
#            JEV_GATE_ALIAS.
set -euo pipefail

MODEL="${JEV_GATE_MODEL_PATH:-/home/kr/Models/active/jevify-gemma4-e4b.Q4_K_M.gguf}"
PORT="${JEV_GATE_PORT:-8082}"
CTX="${JEV_GATE_CTX:-4096}"
THREADS="${JEV_GATE_THREADS:-4}"
ALIAS="${JEV_GATE_ALIAS:-jevify-gemma4-e4b}"
LLAMA_SERVER="${LLAMA_SERVER:-/home/kr/llama.cpp/build/bin/llama-server}"

[[ -e "$MODEL" ]] || { echo "missing gate model: $MODEL" >&2; exit 1; }
[[ -x "$LLAMA_SERVER" ]] || { echo "missing llama-server: $LLAMA_SERVER" >&2; exit 1; }

exec "$LLAMA_SERVER" \
  -m "$MODEL" --alias "$ALIAS" \
  --host 127.0.0.1 --port "$PORT" \
  -c "$CTX" -ngl 0 -np 1 -b 1024 -ub 256 \
  --threads "$THREADS" --threads-batch "$THREADS" \
  --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --jinja
