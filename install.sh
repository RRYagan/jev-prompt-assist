#!/usr/bin/env bash
# Install this plugin/command into opencode by symlinking the canonical sources.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

link() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then
    if [ "$(readlink "$dst")" = "$src" ]; then
      echo "ok      already linked   $dst"
      return
    fi
    echo "replace existing symlink $dst"
    rm "$dst"
  elif [ -e "$dst" ]; then
    local bak="$dst.bak.$(date +%s)"
    echo "backup  real file        $dst -> $bak"
    mv "$dst" "$bak"
  fi
  ln -s "$src" "$dst"
  echo "linked  $dst -> $src"
}

link "$REPO_DIR/src/jev.ts"  "$CONFIG_DIR/plugins/jev.ts"
link "$REPO_DIR/command/jev.md" "$CONFIG_DIR/command/jev.md"

# The TUI half loads from tui.json. Keep this entry in sync with the repo path
# (a file:// spec is imported directly, so no package install is required).
TUI_ENTRY="file://$REPO_DIR/tui.tsx"
TUI_FILE="$CONFIG_DIR/tui.json"
JS=""
if command -v bun >/dev/null 2>&1; then
  JS="bun"
elif command -v node >/dev/null 2>&1; then
  JS="node"
fi
if [ -n "$JS" ]; then
  "$JS" "$REPO_DIR/scripts/tui-entry.mjs" add "$TUI_FILE" "$TUI_ENTRY"
else
  echo
  echo "note: bun/node not found; add this entry to $TUI_FILE manually:"
  echo "      \"$TUI_ENTRY\""
fi

if [ ! -d "$REPO_DIR/node_modules/@opencode-ai/plugin" ] || [ ! -d "$REPO_DIR/node_modules/@opentui/solid" ]; then
  echo
  echo "note: run 'bun install' in $REPO_DIR so '@opencode-ai/plugin' and '@opentui/*' resolve."
fi

echo
echo "Done. Restart opencode to load the plugin/command/live panel (config is read once)."
