#!/usr/bin/env bash
# One-time setup for the lightweight Jev gate endpoint (opencode jev plugin):
#   1. requant Q5_K_M -> Q4_K_M (skipped if the file already exists)
#   2. install + start the systemd user unit on :8082
#   3. write ~/.config/opencode/jev/config.json so the plugin routes gate calls there
#
# Reversible with scripts/uninstall-gate.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/jev"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PORT="${JEV_GATE_PORT:-8082}"
ALIAS="${JEV_GATE_ALIAS:-jevify-gemma4-e4b}"

"$HERE/requant-q4.sh"

mkdir -p "$UNIT_DIR"
cp "$HERE/jev-gate.service" "$UNIT_DIR/jev-gate.service"
systemctl --user daemon-reload
systemctl --user enable --now jev-gate.service

echo "waiting for http://127.0.0.1:${PORT}/v1 ..."
ok=0
for _ in $(seq 1 60); do
  if s1 noul --base-url "http://127.0.0.1:${PORT}/v1" --model "$ALIAS" \
      --state "gate health check" --question "Is this text present" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

mkdir -p "$CONFIG_DIR"
if [[ ! -e "$CONFIG_DIR/config.json" ]]; then
  cat >"$CONFIG_DIR/config.json" <<JSON
{
  "gateBaseUrl": "http://127.0.0.1:${PORT}/v1",
  "gateModel": "${ALIAS}"
}
JSON
  echo "wrote $CONFIG_DIR/config.json"
else
  echo "kept existing $CONFIG_DIR/config.json (add gateBaseUrl/gateModel manually if absent)"
fi

if [[ "$ok" == "1" ]]; then
  echo "gate healthy on http://127.0.0.1:${PORT}/v1 (alias ${ALIAS})"
else
  echo "gate did not answer within 60s; check: systemctl --user status jev-gate" >&2
  exit 1
fi

echo
echo "Restart opencode to pick up the plugin config. Trade-off: the gate adds"
echo "~4 GB RAM and shares the 6 CPU cores; disable with scripts/uninstall-gate.sh."
