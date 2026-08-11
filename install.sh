#!/usr/bin/env bash
# Install the guardrails: copy the hooks to ~/.claude/hooks/ and print the settings.json block.
#
# The hooks are installed to ~/.claude/hooks/ rather than run from this repo on purpose: hook
# commands run through a shell, and a checkout path containing a space is a reliable source of
# quoting bugs. ~/.claude has no spaces.
#
# This script does NOT edit settings.json. Wiring hooks is a change to how every session behaves, so
# it prints the block and lets a human decide. Silent config edits are exactly the kind of
# judgment-substitution these guardrails exist to prevent.

set -uo pipefail
SRC="$(cd "$(dirname "$0")/hooks" && pwd)"
DEST="$HOME/.claude/hooks"

mkdir -p "$DEST"
for f in governing-rules.js work-ledger.js pre-ship-check.js; do
  cp "$SRC/$f" "$DEST/$f" && echo "installed: $DEST/$f"
done

echo
echo "Self-test:"
if printf '{"session_id":"install-check"}' | node "$DEST/governing-rules.js" >/dev/null 2>&1; then
  echo "  hooks run correctly under node"
else
  echo "  FAILED: node could not run the hooks. Install node, or fix the paths above."
  exit 1
fi
rm -f "$HOME/.claude/hooks/.state/turns-install-check" 2>/dev/null

cat <<'BLOCK'

Add this to ~/.claude/settings.json (merge with existing keys, do not replace the file):

  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/governing-rules.js\"", "timeout": 10 } ] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|NotebookEdit|Bash|PowerShell",
        "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/work-ledger.js\"", "timeout": 10 } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|PowerShell",
        "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/pre-ship-check.js\"", "timeout": 10 } ] }
    ]
  }

Then either open /hooks once or restart Claude Code so the config is reloaded.
BLOCK
