#!/usr/bin/env bash
# Requant the Jevified Gemma-4-E4B classifier from Q5_K_M to Q4_K_M.
#
# Drop-in: same architecture and renderer, ~30% smaller (~4.0 GB vs 5.7 GB),
# faster CPU prefill, minor accuracy loss. This is the safest "lightweight CPU
# model" for now because the 0.8B Jev-Style GGUFs may use a custom readout that
# `s1`/jevify cannot read (see PLAN.md).
#
# Overrides: SRC, DST, LLAMA_QUANTIZE, FORCE=1.
set -euo pipefail

SRC="${SRC:-/home/kr/Models/active/jevify-gemma4-e4b.Q5_K_M.gguf}"
DST="${DST:-/home/kr/Models/active/jevify-gemma4-e4b.Q4_K_M.gguf}"
LLAMA_QUANTIZE="${LLAMA_QUANTIZE:-/home/kr/llama.cpp/build/bin/llama-quantize}"

for f in "$SRC" "$LLAMA_QUANTIZE"; do
  [[ -e "$f" ]] || { echo "missing: $f" >&2; exit 1; }
done

if [[ -e "$DST" && "${FORCE:-0}" != "1" ]]; then
  echo "already exists: $DST (set FORCE=1 to overwrite)" >&2
  exit 0
fi

echo "requantizing $SRC -> $DST (Q4_K_M)"
"$LLAMA_QUANTIZE" --allow-requantize "$SRC" "$DST" Q4_K_M
ls -l "$DST"
