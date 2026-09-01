#!/usr/bin/env node
/**
 * EXIT-CODE GATE. `$?` after a pipe is the exit code of the LAST command, not the one you care
 * about, and reading it that way has already made this assistant report success it did not earn.
 *
 * WHY THIS EXISTS
 *   Her rule 12, written into CONTINUITY on 2026-08-12: "EVERYTHING FAILS LOUDLY. Never discard an
 *   exit code." On 2026-08-30 and 31 the assistant discarded one four times in a single session,
 *   always the same way:
 *
 *       python -m pytest tests/ -q | tail -3
 *       echo "SUITE=$?"                    # this is tail's status. tail always succeeds.
 *
 *   The consequences were not theoretical:
 *     - A commit message claimed "212 tests pass" while the run said 2 failed, 210 passed, and it
 *       was pushed. The false claim had to be corrected in the repository's history.
 *     - `git commit && git push` reported PUSH=0 while the push had not happened, because the echo
 *       read `tail` rather than `git`.
 *     - A python heredoc died on an assertion and the `git add` on the next line committed anyway,
 *       reporting success.
 *
 *   Every one of those told Nicole a thing had worked when it had not. That is the single failure
 *   her whole rule set exists to prevent, and a promise to be careful does not survive the session.
 *   This does.
 *
 * WHAT IT BLOCKS
 *   A command that pipes and then reads `$?`, without using `PIPESTATUS`. In bash the fix is
 *   `${PIPESTATUS[0]}`; better still, do not pipe the thing whose status matters, or use
 *   `set -o pipefail`.
 *
 * WHAT IT DELIBERATELY DOES NOT BLOCK
 *   `$?` with no pipe at all, which is correct and common. A pipeline that already uses
 *   PIPESTATUS. `set -o pipefail` in the same command. A `$?` that appears BEFORE the pipe. And
 *   anything that is not Bash. A gate that fires on correct code is one people route around, and
 *   most of these cases are things that must keep working.
 */

const fs = require('fs');

// A pipe that is a real pipeline, not `||` and not inside a redirect like 2>&1.
const PIPE = /(^|[^|>&])\|(?!\|)/;
const DOLLAR_STATUS = /\$\?/;
const PIPESTATUS = /PIPESTATUS/;
const PIPEFAIL = /set\s+-o\s+pipefail|set\s+-[a-z]*o[a-z]*\s+pipefail|pipefail/;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Does this one command both pipe and then read $? from the pipeline?
 * Checked per logical line, because a `$?` on a line with no pipe is fine even if an earlier
 * line piped.
 */
function offendingLine(text) {
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!DOLLAR_STATUS.test(line)) continue;
    if (PIPESTATUS.test(line) || PIPEFAIL.test(line)) continue;
    if (!PIPE.test(line)) continue;
    // $? must come AFTER the pipe to be reading the pipeline's status.
    const firstPipe = line.search(PIPE);
    const status = line.indexOf('$?');
    if (status > firstPipe) return line;
  }
  return null;
}

function decide(input) {
  const tool = input.tool_name || '';
  if (tool !== 'Bash') return null;
  const cmd = (input.tool_input || {}).command;
  if (typeof cmd !== 'string' || !cmd) return null;

  const line = offendingLine(cmd);
  if (!line) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'EXIT-CODE GATE: this reads $? after a pipe, so it reports the status of the LAST command '
        + 'in the pipeline, not the one you care about. `tail`, `sed`, `head` and `grep` almost '
        + 'always succeed, so the check passes even when the real command failed.\n'
        + '  ' + line.slice(0, 160) + '\n'
        + 'On 2026-08-30 this exact shape produced a commit message claiming 212 tests passed while '
        + '2 were failing, and a PUSH=0 for a push that had not happened.\n'
        + 'Use ${PIPESTATUS[0]}, or add `set -o pipefail`, or do not pipe the command whose status '
        + 'matters. Her rule: never discard an exit code.',
    },
  };
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (e) {
    process.exit(0); // never break the session on a parse failure
  }
  const out = decide(input);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (require.main === module) main();

module.exports = { decide, offendingLine };
