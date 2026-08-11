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
assert_contains governing-rules.js '{"session_id":"test-a"}' 'HER JUDGMENT GOVERNS' "injects the core rules"
assert_contains governing-rules.js 'garbage' 'HER JUDGMENT GOVERNS' "injects rules even on garbage input"
assert_contains governing-rules.js '{"session_id":"test-a"}' 'additionalContext' "uses the additionalContext channel"

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
                "bash tests/run-tests.sh", "./run-tests.sh", "sh scripts/test-all.sh"];
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
echo "----------------------------------------"
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
