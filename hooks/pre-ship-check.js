#!/usr/bin/env node
/**
 * PreToolUse hook (Bash/PowerShell): inject a verification reminder at the exact moment work is
 * about to reach the outside world.
 *
 * WHY THIS EXISTS
 * Every serious failure landed at the same instant: pushing or deploying, then reporting success
 * without checking from the position a real user occupies. A rule stated once at session start does
 * not survive to that moment. This fires AT that moment, every time.
 *
 * It deliberately does NOT block. Blocking a legitimate deploy would be obstruction, and the point
 * is transparency, not obstruction. It states the standard and lets the work proceed.
 *
 * SAFETY CONTRACT
 * On any error it allows the command and exits 0. A reminder must never be able to stop real work.
 */

'use strict';

/** Commands that push work outward, where "I think it worked" has historically been wrong. */
const SHIP_PATTERNS = [
  /\bgit\s+push\b/,
  /\bsystemctl\s+(restart|reload|start)\b/,
  /\bdocker\s+(push|compose\s+up)\b/,
  /\bkubectl\s+(apply|rollout)\b/,
  /\bvercel\s+(deploy|--prod)\b/,
  /\bnetlify\s+deploy\b/,
  /\brsync\b.*::/,
  /\bssh\b[^|]*\b(deploy|restart|pull)\b/,
  /\bnpm\s+publish\b/,
  /\bpm2\s+(restart|reload)\b/,
  /\bterraform\s+apply\b/,
  /\bflyctl?\s+deploy\b/,
];

const REMINDER = [
  'ABOUT TO SHIP. Before you describe any of this as done or working:',
  '- Verify from the position a real reader or user occupies, on the plain URL or entry point,',
  '  with no cache-buster and no path you control.',
  '- If the behavior depends on time, state, or emptiness, reason through more than one moment:',
  '  right now, this evening, tomorrow morning, and the empty case.',
  '- Report what you checked AND what you did not check. Name anything still unproven.',
  '- If you cannot show output that demonstrates it works, say so plainly instead of implying it.',
].join('\n');

function isShipping(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return SHIP_PATTERNS.some((re) => re.test(command));
}

function allowQuietly() {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
  process.exit(0);
}

function main(raw) {
  const input = JSON.parse(raw);
  const cmd = input && input.tool_input && input.tool_input.command;
  if (!isShipping(cmd)) return allowQuietly();

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: REMINDER,
      },
      suppressOutput: true,
    })
  );
  process.exit(0);
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
    allowQuietly();
  }
});
process.stdin.on('error', () => allowQuietly());

module.exports = { isShipping };
