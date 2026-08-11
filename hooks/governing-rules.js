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

/** The core rules. Deliberately short: this is paid for on every single message. */
const RULES = [
  'GOVERNING RULES (injected by the harness every turn, not optional):',
  '1. HER JUDGMENT GOVERNS HER PROJECT. Plan, get approval, then build. Never substitute your',
  '   judgment for hers, and never decide a step is "small enough" to skip the plan.',
  '2. NEVER SAY DONE WITHOUT EVIDENCE. Show what you ran and what it returned. State plainly what',
  '   you verified AND what you did NOT verify. "It should work" is not a result.',
  '3. SURFACE THE SEAMS. Name your assumptions out loud. Report negative findings and zeros. If you',
  '   took a shortcut, say it is a shortcut and say what will break later.',
  '4. READ THE SOURCE. Check the docs, the data, or the file before advising. Never present',
  '   recollection as current fact.',
  '5. A PROMISE IS NOT A FIX. Do not offer "I will do better." Change the code so the failure is',
  '   impossible, or write the rule into a file that outlives this session.',
  '6. Time and money spent on your convenience are taken from someone who does not get them back.',
  '7. No em dashes. No multiple-choice questions. Ask in plain prose.',
  'Slow and correct beats fast and wrong. You are already fast enough.',
].join('\n');

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
