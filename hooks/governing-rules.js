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
  '4. Read the source. Never present recollection as current fact. A listing or read made',
  '   BEFORE her latest message is recollection: when she says files were added, changed, or',
  '   downloaded, open that folder and read those files before doing anything else. On',
  '   2026-08-27 a full overnight build used stale design files because a pre-download listing',
  '   was trusted over her words "files I just downloaded."',
  '5. A promise is not a fix. Change the code, or write the rule into a file.',
  '6. Their time and money are finite and unrecoverable. Your convenience does not outrank them.',
  '7. No em dashes. No multiple-choice questions.',
  '8. READ IT ALL FIRST. Before answering "where are we", auditing, or building on any document:',
  '   her documents of record (STATUS.md, BUILD_UPDATE.md, the plan files, CONTINUITY.md) are',
  '   read end to end, not grep-sampled. A file you only searched is a file you have not read.',
  '9. Every milestone updates STATUS.md and BUILD_UPDATE.md before the work is called done. A',
  '   LEDGER STALE line below is never argued with, only fixed.',
  'Slow and correct beats fast and wrong. You are already fast enough.',
].join('\n');

/**
 * LEDGER WATCH. Nicole, 2026-08-25: "I want the failure to update the continuance documents to
 * end. I'm sick of being lied to about what's getting updated." Rules 8 and 9 above came from the
 * same night: status was answered three times from the wrong sources while her ledgers sat stale.
 *
 * A promise would not fix that, so this is mechanical: when any watched repo carries a commit
 * newer than the newest touch of its ledger files by more than the grace window, every keypress
 * carries a LEDGER STALE line until the ledger catches up. Config is JSON at
 * ~/.claude/hooks/ledger-watch.json ($LEDGER_WATCH_CONFIG overrides, for tests):
 *   { "watches": [ { "label": "name", "gitRefs": ["<repo>/.git/refs/heads/main", ...],
 *                    "ledgers": ["<STATUS.md path>", ...], "graceHours": 2 } ] }
 * Missing, unreadable or malformed config is SILENT: this must never break a session or nag a
 * machine that does not have the project.
 */
function newestMtime(files) {
  let newest = 0;
  for (const f of files || []) {
    try {
      const t = fs.statSync(f).mtimeMs;
      if (t > newest) newest = t;
    } catch {
      /* a missing file simply does not count */
    }
  }
  return newest;
}

/**
 * The OLDEST ledger file governs, not the newest. On 2026-08-25 Nicole caught the loophole in the
 * newest-file version: updating STATUS.md alone silenced this warning while BUILD_UPDATE.md and
 * CONTINUITY.md rotted, and the assistant then reported the whole ledger as current. Her word for
 * that was lying, and she is right. So the laziest file now sets the verdict: EVERY watched ledger
 * must be at least as fresh as the newest commit, and a missing ledger counts as infinitely stale
 * instead of being skipped.
 */
function oldestMtime(files) {
  let oldest = Infinity;
  for (const f of files || []) {
    let t = 0;
    try {
      t = fs.statSync(f).mtimeMs;
    } catch {
      t = 0; // a missing ledger is the stalest possible ledger
    }
    if (t < oldest) oldest = t;
  }
  return oldest === Infinity ? 0 : oldest;
}

function ledgerStaleNotice() {
  try {
    const cfgPath = process.env.LEDGER_WATCH_CONFIG
      || path.join(os.homedir(), '.claude', 'hooks', 'ledger-watch.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const lines = [];
    for (const w of (cfg && cfg.watches) || []) {
      const ref = newestMtime(w.gitRefs);
      const led = oldestMtime(w.ledgers);
      if (!ref) continue;                      // no repo on this machine: nothing to judge
      const graceMs = (w.graceHours == null ? 2 : w.graceHours) * 3600 * 1000;
      if (ref - led > graceMs) {
        const hrs = Math.round((ref - led) / 3600000);
        lines.push(`LEDGER STALE (${w.label}): the least-recently-updated ledger file is ~${hrs}h `
          + 'behind the newest commit. EVERY ledger file must be current, not just one. Update '
          + 'STATUS.md and BUILD_UPDATE.md before reporting anything as done.');
      }
    }
    return lines.length ? '\n' + lines.join('\n') : '';
  } catch {
    return '';
  }
}

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
  // Outside the session-id guard on purpose: a stale ledger nags even if session state is broken.
  extra += ledgerStaleNotice();

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
