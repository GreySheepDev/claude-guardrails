#!/usr/bin/env node
/**
 * UserPromptSubmit hook: re-inject the governing rules on EVERY user message.
 *
 * WHY THIS EXISTS
 * The rules were already written down and loaded at session start, and were still violated
 * six hours into a long session. That is not a knowledge failure, it is an attention failure:
 * instructions sit at the very beginning of the context, and after hundreds of messages the
 * recent text dominates. Re-injecting on every turn puts the rules in the most recent position
 * so they cannot drift out of view. The harness runs this, not the model, so it fires whether
 * or not the model is paying attention.
 *
 * SAFETY CONTRACT
 * This must NEVER break a session. Every failure path still emits valid JSON and exits 0.
 * If anything at all goes wrong, it falls back to the static rules.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', '.state');

/**
 * The core rules. Every character here is paid for on every single message of every session, so
 * the wording is compressed hard. Being wasteful with someone's tokens while telling yourself to
 * respect their resources would be its own kind of failure.
 */
const RULES = [
  'GOVERNING RULES (harness-injected every turn):',
  '1. Their judgment governs their project. Plan, get approval, then build. No step is "small',
  '   enough" to skip that.',
  '2. Never say done without evidence. Show the output. Say what you did NOT verify.',
  '3. Surface the seams: name assumptions, report zeros, call a shortcut a shortcut.',
  '4. Read the source. Never present recollection as current fact.',
  '5. A promise is not a fix. Change the code, or write the rule into a file.',
  '6. Their time and money are finite and unrecoverable. Your convenience does not outrank them.',
  '7. No em dashes. No multiple-choice questions.',
  'Slow and correct beats fast and wrong. You are already fast enough.',
].join('\n');

/**
 * State files are two per session and nothing else would ever remove them, which is a slow leak
 * left for someone else to discover. Pruned once per session (on the first turn) rather than on
 * every message, so the cost is negligible.
 */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function pruneOldState() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STATE_TTL_MS) fs.unlinkSync(file);
      } catch {
        /* skip anything that vanishes or is locked */
      }
    }
  } catch {
    /* the state dir may not exist yet */
  }
}

/** Read a small integer from a state file, defaulting to 0. */
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
    /* state is a nicety, never a requirement */
  }
}

/**
 * Long sessions are where the drift happens, so the reminder gets firmer as the session grows
 * rather than staying flat. The thresholds are deliberately conservative to avoid nagging.
 */
function driftNotice(turns) {
  if (turns >= 120) {
    return `\nSESSION LENGTH: ${turns} turns. This is exactly where past sessions went wrong: patching\nsymptoms, skipping the plan, and calling things done that were not checked. Re-read rules 1 and 2\nbefore your next action.`;
  }
  if (turns >= 60) {
    return `\nSESSION LENGTH: ${turns} turns. Attention to these rules decays with length. Slow down.`;
  }
  return '';
}

/**
 * The work ledger (maintained by work-ledger.js) counts files changed since the last time any
 * verification command ran. Reporting it as a fact is the mechanical version of "surface the
 * seams": it is much harder to claim something works while the count is staring at you.
 */
function ledgerNotice(sessionId) {
  const edits = readCount(path.join(STATE_DIR, `edits-${sessionId}`));
  if (edits <= 0) return '';
  const noun = edits === 1 ? 'file change' : 'file changes';
  return `\nUNVERIFIED WORK: ${edits} ${noun} since the last verification command ran. Do not report\nany of it as working until you have run something that proves it and shown the output.`;
}

function emit(context) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
    suppressOutput: true,
  };
  process.stdout.write(JSON.stringify(payload));
}

function main(raw) {
  let sessionId = 'unknown';
  try {
    const input = JSON.parse(raw);
    if (input && typeof input.session_id === 'string') sessionId = input.session_id;
  } catch {
    /* fall through with the static rules */
  }

  let extra = '';
  if (sessionId !== 'unknown') {
    const turnsFile = path.join(STATE_DIR, `turns-${sessionId}`);
    const turns = readCount(turnsFile) + 1;
    writeCount(turnsFile, turns);
    if (turns === 1) pruneOldState();
    extra = driftNotice(turns) + ledgerNotice(sessionId);
  }

  emit(RULES + extra);
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
    emit(RULES); // never leave the session without the rules, never crash it
  }
  process.exit(0);
});
process.stdin.on('error', () => {
  emit(RULES);
  process.exit(0);
});
