/**
 * The gate must block the exact shapes that lied to Nicole, and nothing else.
 *
 * Every blocked case below is a real command run in the session of 2026-08-30 and 31. Every
 * allowed case is ordinary correct work that must keep running: a gate that fires on correct code
 * is one people learn to route around, and then it protects nothing.
 */

const { decide, offendingLine } = require('../hooks/exit-code-gate.js');

let pass = 0;
let fail = 0;

function check(name, cmd, wantBlocked) {
  const got = decide({ tool_name: 'Bash', tool_input: { command: cmd } }) !== null;
  if (got === wantBlocked) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${name}: expected ${wantBlocked ? 'BLOCKED' : 'allowed'}, got ${got ? 'BLOCKED' : 'allowed'}`);
  }
}

// ── must BLOCK: the real commands that produced false success ─────────────────────────────────

check('the one that claimed 212 tests passed while 2 failed',
  'python -m pytest tests/ -q 2>&1 | tail -3; echo "SUITE=$?"', true);

check('the one that reported PUSH=0 for a push that had not happened',
  'git commit -q -m x && git push -q origin HEAD 2>&1|tail -1; echo "PUSH=$?"', true);

check('deploy exit read through a tail',
  'ssh root@host "bash deploy.sh 2>&1 | tail -3; echo DEPLOY_EXIT=$?"', true);

check('checker exit read through a grep',
  'python scripts/check.py 2>&1 | grep -v Warning | tail -1; echo "  exit=$?"', true);

check('sed in the way',
  'aws s3 cp file s3://b/k 2>&1 | sed "s/^/  /"; echo "  exit=$?"', true);

check('multiline, offending line is the second',
  'echo starting\npython -m pytest -q | tail -2; echo "EXIT=$?"', true);

// ── must ALLOW: correct code, which is most code ──────────────────────────────────────────────

check('$? with no pipe at all is correct and common',
  'python -m pytest tests/ -q; echo "SUITE=$?"', false);

check('PIPESTATUS is the actual fix and must not be blocked',
  'python -m pytest -q | tail -3; echo "EXIT=${PIPESTATUS[0]}"', false);

check('pipefail makes the pipeline status meaningful',
  'set -o pipefail; python -m pytest -q | tail -3; echo "EXIT=$?"', false);

check('$? BEFORE a pipe is reading the right thing',
  'python x.py; echo $? | tee status.txt', false);

check('a pipeline with no $? anywhere',
  'grep -rn foo pipeline/ | head -20', false);

check('|| is not a pipe',
  'python x.py || echo "failed with $?"', false);

check('2>&1 redirect is not a pipe',
  'python x.py 2>&1; echo "exit=$?"', false);

check('a comment mentioning the pattern is not code',
  '# do not write: cmd | tail; echo $?\npython x.py; echo $?', false);

check('not a Bash tool call',
  null, false);

// A PowerShell call carrying the same text must not be blocked by THIS gate.
{
  const got = decide({ tool_name: 'PowerShell', tool_input: { command: 'x | tail; echo $?' } });
  if (got === null) pass++; else { fail++; console.log('  FAIL: blocked a PowerShell call'); }
}

// ── the helper itself ─────────────────────────────────────────────────────────────────────────

{
  const line = offendingLine('a\npython -m pytest -q | tail -2; echo "EXIT=$?"\nb');
  if (line && line.includes('pytest')) pass++;
  else { fail++; console.log('  FAIL: offendingLine did not return the guilty line'); }
}

console.log(`\nexit-code-gate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
