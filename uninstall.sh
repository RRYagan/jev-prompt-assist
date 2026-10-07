#!/usr/bin/env bash
# Remove the opencode symlinks created by install.sh (only if they point here).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

unlink() {
  local src="$1" dst="$2"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    rm "$dst"
    echo "removed $dst"
  elif [ -e "$dst" ]; then
    echo "skip    $dst (not a symlink to this project)"
  else
    echo "ok      $dst (absent)"
  fi
}

unlink "$REPO_DIR/src/jev.ts"    "$CONFIG_DIR/plugins/jev.ts"
unlink "$REPO_DIR/command/jev.md" "$CONFIG_DIR/command/jev.md"

# Remove the TUI half's tui.json entry, preserving any other plugins.
TUI_ENTRY="file://$REPO_DIR/tui.tsx"
JS=""
if command -v bun >/dev/null 2>&1; then
  JS="bun"
elif command -v node >/dev/null 2>&1; then
  JS="node"
fi
if [ -n "$JS" ]; then
  "$JS" "$REPO_DIR/scripts/tui-entry.mjs" remove "$CONFIG_DIR/tui.json" "$TUI_ENTRY"
else
  echo "note: remove this entry from $CONFIG_DIR/tui.json manually: \"$TUI_ENTRY\""
fi

echo
echo "Restart opencode to apply."
