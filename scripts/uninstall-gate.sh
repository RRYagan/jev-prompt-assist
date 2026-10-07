#!/usr/bin/env bash
# Stop and remove the Jev gate systemd user unit. The requantized model file is
# left in place; delete it manually if you want the ~4 GB back.
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

systemctl --user disable --now jev-gate.service 2>/dev/null || true
rm -f "$UNIT_DIR/jev-gate.service"
systemctl --user daemon-reload
echo "removed jev-gate.service (model file left in place)"
