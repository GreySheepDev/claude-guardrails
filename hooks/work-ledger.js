#!/usr/bin/env node
/**
 * PostToolUse hook: keep a running count of file changes made since anything was actually verified.
 *
 * WHY THIS EXISTS
 * The most expensive failure pattern is reporting work as finished after checking nothing, or after
 * checking one thing at one moment. Intentions do not fix that. A number does. This maintains a
 * simple ledger per session:
 *   - every Edit / Write increments the count of unverified changes
 *   - every command that actually PROVES something (a request, a test run, a build, a query)
 *     resets it to zero
 * governing-rules.js then reports the count back on the next turn, so a claim of "it works" has to
 * be made with the unverified count visible. It is the "surface the seams" rule made mechanical.
 *
 * SAFETY CONTRACT
 * Emits nothing and exits 0 no matter what. A bookkeeping hook must never interrupt real work.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', '.state');

/**
 * Commands that constitute evidence. The test is deliberately conservative: a command only clears
 * the ledger if it could actually demonstrate that something behaves correctly. Moving files
 * around, staging commits, or listing a directory proves nothing and must not clear it.
 */
const VERIFICATION_PATTERNS = [
  /\bcurl\b/,                                   // hitting a real URL
  /\bwget\b/,
  /\bpytest\b/,
  /\bnpm\s+(run\s+)?(test|build)\b/,            // a build proves it compiles
  /\byarn\s+(test|build)\b/,
  /\bpnpm\s+(test|build)\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+(test|build)\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bmocha\b/,
  /\bphpunit\b/,
  /\brspec\b/,
  /\bpsql\b/,                                   // querying the data rather than assuming it
  /\bsqlite3\b/,
  /\bmysql\b/,
  /\bsystemctl\s+(is-active|status)\b/,
  /\bdocker\s+(ps|logs)\b/,
  /\bkubectl\s+(get|describe|logs)\b/,
  /\bnode\s+.*test/i,
  /\bpython[0-9.]*\s+-m\s+(pytest|unittest)\b/,
  /\bmake\s+(test|check)\b/,
  /\btsc\b/,                                    // type-checking is real verification
  /\beslint\b/,
  /\bruff\b/,
  /\bblack\s+--check\b/,
  // Running a test script directly, e.g. "bash tests/run-tests.sh" or "./run-tests.sh".
  // Found by using this hook for real: the suite for these very hooks did not clear the ledger.
  /\b(?:bash|sh|zsh)\s+[^\s;|&]*test[^\s;|&]*\.(?:sh|bash)\b/,
  /(?:^|[\s;|&])\.?\/?[^\s;|&]*test[^\s;|&]*\.(?:sh|bash)\b/,
  // Querying a remote service for its actual state is verification. Also found in real use:
  // confirming a published license via "gh api" did not clear the ledger.
  /\bgh\s+(?:api|repo\s+view|run\s+(?:list|view)|pr\s+(?:view|checks))\b/,
  /\baws\s+\w+\s+(?:describe|get|list)-/,
  /\bgcloud\s+\w+\s+(?:describe|list)\b/,
];

function isVerification(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return VERIFICATION_PATTERNS.some((re) => re.test(command));
}

function readCount(file) {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCount(file, n) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, String(n));
  } catch {
    /* bookkeeping only */
  }
}

function main(raw) {
  const input = JSON.parse(raw);
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
  if (!sessionId) return;

  const tool = input.tool_name;
  const ledger = path.join(STATE_DIR, `edits-${sessionId}`);

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    writeCount(ledger, readCount(ledger) + 1);
    return;
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = input.tool_input && input.tool_input.command;
    if (isVerification(cmd)) writeCount(ledger, 0);
  }
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  data += chunk;
});
process.stdin.on('end', () => {
  try {
    main(data);
  } catch {
    /* never interrupt real work */
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));

module.exports = { isVerification };
