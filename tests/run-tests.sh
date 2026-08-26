#!/usr/bin/env bash
# Test suite for the guardrail hooks.
#
# These hooks sit in the path of every message and every command, so the bar is not "it works on
# the happy path" but "it cannot break a session." Most of these tests are deliberately hostile:
# malformed input, empty input, missing fields. A hook that crashes is worse than no hook.

set -uo pipefail
HOOKS="$(cd "$(dirname "$0")/../hooks" && pwd)"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

# Assert: running $2 through the hook $1 exits 0 and prints parseable JSON.
assert_valid_json() {
  local hook="$1" input="$2" label="$3"
  local out rc
  out=$(printf '%s' "$input" | node "$HOOKS/$hook" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ]; then bad "$label (exit $rc)"; return; fi
  if [ -z "$out" ]; then ok "$label (no output, allowed)"; return; fi
  if printf '%s' "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{JSON.parse(d);})' 2>/dev/null; then
    ok "$label"
  else
    bad "$label (invalid JSON: $out)"
  fi
}

# Assert: the hook's output contains a given substring.
assert_contains() {
  local hook="$1" input="$2" needle="$3" label="$4"
  local out
  out=$(printf '%s' "$input" | node "$HOOKS/$hook" 2>/dev/null)
  case "$out" in
    *"$needle"*) ok "$label" ;;
    *) bad "$label (missing '$needle')" ;;
  esac
}

assert_not_contains() {
  local hook="$1" input="$2" needle="$3" label="$4"
  local out
  out=$(printf '%s' "$input" | node "$HOOKS/$hook" 2>/dev/null)
  case "$out" in
    *"$needle"*) bad "$label (unexpectedly contains '$needle')" ;;
    *) ok "$label" ;;
  esac
}

echo "governing-rules.js"
assert_valid_json governing-rules.js '{"session_id":"test-a","prompt":"hi"}' "valid input produces valid JSON"
assert_valid_json governing-rules.js '' "empty stdin does not crash"
assert_valid_json governing-rules.js 'not json at all {{{' "malformed stdin does not crash"
assert_valid_json governing-rules.js '{}' "missing session_id does not crash"
assert_contains governing-rules.js '{"session_id":"test-a"}' 'Never say done without evidence' "injects the core rules"
assert_contains governing-rules.js 'garbage' 'Never say done without evidence' "injects rules even on garbage input"
assert_contains governing-rules.js '{"session_id":"test-a"}' 'additionalContext' "uses the additionalContext channel"
assert_contains governing-rules.js '{"session_id":"test-a"}' 'GOVERNING RULES' "block is labelled so it is recognisable in context"
assert_contains governing-rules.js '{"session_id":"test-a"}' 'judgment governs' "carries the judgment-deference rule"

echo
echo "work-ledger.js"
assert_valid_json work-ledger.js '{"session_id":"test-b","tool_name":"Edit","tool_input":{"file_path":"x.js"}}' "edit event does not crash"
assert_valid_json work-ledger.js '{"session_id":"test-b","tool_name":"Bash","tool_input":{"command":"curl https://example.com"}}' "bash event does not crash"
assert_valid_json work-ledger.js 'bogus' "malformed stdin does not crash"

# The classifier is the part with real judgement in it, so test it directly.
node -e '
const {isVerification} = require(process.argv[1] + "/work-ledger.js");
const proves = ["curl https://x.com", "npm test", "npm run build", "pytest -q", "psql -c select 1",
                "systemctl is-active nginx", "go test ./...", "tsc --noEmit", "black --check .",
                // found in real use: running a test script directly must count
                "bash tests/run-tests.sh", "./run-tests.sh", "sh scripts/test-all.sh",
                // found in real use: querying a remote for its actual state must count
                "gh api repos/x/y", "gh repo view x/y --json name", "gh run list",
                "aws s3api list-buckets", "gcloud compute instances list"];
const provesNothing = ["git add -A", "git commit -m x", "ls -la", "cd /tmp", "echo hi",
                       "mkdir foo", "cat file.txt", "git push origin main",
                       "bash deploy.sh", "bash install.sh"];
let bad = 0;
for (const c of proves) if (!isVerification(c)) { console.log("  FAIL  should count as verification: " + c); bad++; }
for (const c of provesNothing) if (isVerification(c)) { console.log("  FAIL  should NOT count as verification: " + c); bad++; }
if (!bad) console.log("  PASS  verification classifier (" + (proves.length + provesNothing.length) + " cases)");
process.exit(bad ? 1 : 0);
' "$HOOKS" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo
echo "pre-ship-check.js"
assert_contains pre-ship-check.js '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' 'ABOUT TO SHIP' "fires on git push"
assert_contains pre-ship-check.js '{"tool_name":"Bash","tool_input":{"command":"systemctl restart app"}}' 'ABOUT TO SHIP' "fires on systemctl restart"
assert_not_contains pre-ship-check.js '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' 'ABOUT TO SHIP' "stays quiet on harmless commands"
assert_not_contains pre-ship-check.js '{"tool_name":"Bash","tool_input":{"command":"git status"}}' 'ABOUT TO SHIP' "stays quiet on git status"
assert_valid_json pre-ship-check.js 'not json' "malformed stdin does not crash"
assert_valid_json pre-ship-check.js '{}' "missing tool_input does not crash"


echo
echo "governing-rules.js: ledger watch (rule 9 enforcement)"
# Build a disposable fixture: a repo ref newer than its ledger fires; touched ledger silences.
LW="$(mktemp -d)"
mkdir -p "$LW/repo/.git/refs/heads" "$LW/docs"
echo x > "$LW/repo/.git/refs/heads/main"
echo x > "$LW/docs/STATUS.md"
node -e '
const fs=require("fs");const p=process.argv[1];
fs.writeFileSync(p+"/cfg.json",JSON.stringify({watches:[{label:"fixture",
  gitRefs:[p+"/repo/.git/refs/heads/main"],ledgers:[p+"/docs/STATUS.md"],graceHours:2}]}));
const old=(Date.now()-6*3600*1000)/1000;
fs.utimesSync(p+"/docs/STATUS.md",old,old);
' "$LW"
out=$(printf '%s' '{"session_id":"lw-stale"}' | LEDGER_WATCH_CONFIG="$LW/cfg.json" node "$HOOKS/governing-rules.js" 2>/dev/null)
case "$out" in *'LEDGER STALE (fixture)'*) ok "stale ledger fires the warning" ;; *) bad "stale ledger fires the warning" ;; esac
touch "$LW/docs/STATUS.md"
out=$(printf '%s' '{"session_id":"lw-fresh"}' | LEDGER_WATCH_CONFIG="$LW/cfg.json" node "$HOOKS/governing-rules.js" 2>/dev/null)
case "$out" in *'LEDGER STALE ('*) bad "fresh ledger stays silent" ;; *) ok "fresh ledger stays silent" ;; esac
# The 2026-08-26 loophole, planted so it can never return: TWO ledger files, only one updated.
# The stale one must keep the warning firing; updating both must silence it.
node -e '
const fs=require("fs");const p=process.argv[1];
fs.writeFileSync(p+"/docs/BUILD_UPDATE.md","x");
fs.writeFileSync(p+"/cfg.json",JSON.stringify({watches:[{label:"fixture",
  gitRefs:[p+"/repo/.git/refs/heads/main"],ledgers:[p+"/docs/STATUS.md",p+"/docs/BUILD_UPDATE.md"],graceHours:2}]}));
const old=(Date.now()-6*3600*1000)/1000;
fs.utimesSync(p+"/docs/BUILD_UPDATE.md",old,old);   // BUILD_UPDATE rots while STATUS is fresh
' "$LW"
out=$(printf '%s' '{"session_id":"lw-half"}' | LEDGER_WATCH_CONFIG="$LW/cfg.json" node "$HOOKS/governing-rules.js" 2>/dev/null)
case "$out" in *'LEDGER STALE ('*) ok "one fresh file cannot silence a stale sibling" ;; *) bad "one fresh file cannot silence a stale sibling" ;; esac
touch "$LW/docs/BUILD_UPDATE.md"
out=$(printf '%s' '{"session_id":"lw-both"}' | LEDGER_WATCH_CONFIG="$LW/cfg.json" node "$HOOKS/governing-rules.js" 2>/dev/null)
case "$out" in *'LEDGER STALE ('*) bad "both fresh silences the warning" ;; *) ok "both fresh silences the warning" ;; esac
out=$(printf '%s' '{"session_id":"lw-none"}' | LEDGER_WATCH_CONFIG="$LW/missing.json" node "$HOOKS/governing-rules.js" 2>/dev/null)
case "$out" in *'LEDGER STALE ('*) bad "missing config stays silent" ;; *) ok "missing config stays silent" ;; esac
echo '{{{' > "$LW/bad.json"
assert_valid_json governing-rules.js '{"session_id":"lw-bad"}' "malformed ledger config does not crash"
assert_contains governing-rules.js '{"session_id":"lw-r8"}' 'READ IT ALL FIRST' "carries rule 8 (read it all)"
assert_contains governing-rules.js '{"session_id":"lw-r9"}' 'updates STATUS.md and BUILD_UPDATE.md' "carries rule 9 (ledger discipline)"
rm -rf "$LW"
echo
echo "----------------------------------------"
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
