#!/usr/bin/env bash
# Installs clodeKs for the current user. Safe to run again.
#
#   ./install.sh                     link the CLI, write the env file, link the systemd units
#   ./install.sh --enable-services   also enable and start the app-server and inbox units
#   ./install.sh --codex-skill       also link the claude-peer skill into Codex
#   ./install.sh --claude-mod        also link the Claude plugin into the mods folder
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
CONF_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/clodeks"
UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
CODEX_SKILLS="${CODEX_HOME:-${HOME}/.codex}/skills"
MODS_DIR="${HOME}/.local/share/claude-code-mods"

enable_services=false
codex_skill=false
claude_mod=false
for arg in "$@"; do
  case "$arg" in
    --enable-services) enable_services=true ;;
    --codex-skill) codex_skill=true ;;
    --claude-mod) claude_mod=true ;;
    *) echo "install.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "install.sh: node not found on PATH. Install Node 22 or newer." >&2
  exit 1
fi
node_major="$("$node_bin" -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  echo "install.sh: node $node_major found at $node_bin. clodeKs needs Node 22 or newer." >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR"

# Replaces a link. Refuses a real file or folder, so a re-run never nests a link inside it.
link() {
  local src="$1" dst="$2"
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    echo "install.sh: $dst exists and is not a link. Move it away and run again." >&2
    exit 1
  fi
  ln -sfn "$src" "$dst"
  echo "linked $dst"
}

link "$REPO/bin/clodeks.mjs" "$BIN_DIR/clodeks"

# The services run outside any shell, so nvm puts nothing on their PATH. Record where codex lives now.
codex_bin="${CLODEKS_CODEX_BIN:-$(command -v codex || true)}"
if [[ -z "$codex_bin" || ! -x "$codex_bin" ]]; then
  echo "install.sh: codex not found on PATH. Install it, or set CLODEKS_CODEX_BIN, and run again." >&2
  exit 1
fi
# These are absolute nvm paths. Run install.sh again after a Node or Codex upgrade.
printf '# Written by clodeKs install.sh. A re-run replaces this file.\nCLODEKS_CODEX_BIN=%s\nPATH=%s:%s/.local/bin:/usr/local/bin:/usr/bin:/bin\n' \
  "$codex_bin" "$(dirname "$node_bin")" "$HOME" > "$CONF_DIR/env"
echo "wrote $CONF_DIR/env (node: $node_bin, codex: $codex_bin)"

for unit in clodeks-appserver.service clodeks-inboxd.service clodeks-recycle.service clodeks-recycle.timer; do
  link "$REPO/systemd/$unit" "$UNIT_DIR/$unit"
done
if ! systemctl --user daemon-reload 2>/dev/null; then
  echo "install.sh: no user systemd bus here. Run 'systemctl --user daemon-reload' in a login session." >&2
fi

if $enable_services; then
  systemctl --user enable --now clodeks-appserver.service clodeks-inboxd.service
  echo "enabled clodeks-appserver and clodeks-inboxd"
fi

if $codex_skill; then
  mkdir -p "$CODEX_SKILLS"
  link "$REPO/codex/skills/claude-peer" "$CODEX_SKILLS/claude-peer"
fi

if $claude_mod; then
  mkdir -p "$MODS_DIR"
  link "$REPO/plugin" "$MODS_DIR/clodeks"
  cat <<EOF
Add this folder to CLAUDE_CODE_PLUGIN_DIRS in the env block of ~/.claude/settings.json:
  $MODS_DIR/clodeks
New Claude Code sessions then load the clodeks mod.
EOF
fi

cat <<EOF

Next steps:
  clodeks doctor
  Load the Claude plugin for one session:  claude --plugin-dir $REPO/plugin
  Or install it:                           claude plugin marketplace add $REPO
                                           claude plugin install clodeks@clodeks
EOF
