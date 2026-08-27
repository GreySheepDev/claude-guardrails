#!/usr/bin/env node
/**
 * FRESH FILES GATE: mechanical enforcement of "read what she names."
 *
 * WHY THIS EXISTS
 * On 2026-08-27 Nicole said "the files I just downloaded" and an entire overnight build ran on
 * the STALE files sitting next to her new zip, because a folder listing taken before her message
 * was trusted as current. The injected rules said to read the source; text cannot stop a tool
 * call. This hook can. Her question, verbatim: "WHY CAN THEY NOT ENFORCE 'READ WHAT SHE NAMES'?"
 * This is that enforcement, to the extent the harness allows, with its limits stated in README.
 *
 * MECHANISM (three hook events, one state file per session)
 *  1. UserPromptSubmit: scan the configured roots for files whose mtime is newer than the
 *     previous prompt (excluding ignored dirs and files the assistant itself wrote via
 *     Edit/Write). Inject the list so the new files are VISIBLE FACT, not memory. If her
 *     message carries a file cue (a word like "download", "file", "folder", "zip", or a name
 *     matching one of the changed paths), ARM THE GATE: the pending set must be emptied by
 *     actually looking at those files.
 *  2. PreToolUse on Edit|Write|NotebookEdit: while the gate is armed and pending files remain
 *     unread, DENY the tool call, naming the unread files. Editing anything while her named
 *     files sit unopened is the exact failure; it is now impossible rather than forbidden.
 *  3. PostToolUse on Read|Glob|Bash|PowerShell: reading a pending file (or listing/extracting
 *     inside its directory) clears it. Edit/Write records assistant-written paths so the next
 *     scan does not flag the assistant's own work as hers.
 *
 * SAFETY CONTRACT: identical to the other hooks. Every failure path is silent and exits 0;
 * a broken gate must never break her session. The gate fails OPEN, and the tests prove the
 * closed direction on purpose.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.FRESH_FILES_STATE
  || path.join(os.homedir(), '.claude', 'hooks', '.state');
const CONFIG_PATH = process.env.FRESH_FILES_CONFIG
  || path.join(os.homedir(), '.claude', 'hooks', 'fresh-files.json');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.next', '.venv', '__pycache__',
  'dist', 'build', '_backups', '.state', 'out']);
const CUE_WORDS = /\b(download|downloaded|file|files|folder|zip|csv|png|added|changed|updated|new version|dropped|saved)\b/i;
const MAX_DEPTH = 6;
const MAX_LIST = 20;
const SCAN_BUDGET_MS = 2500;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch { /* state is best-effort; the gate fails open */ }
}
function norm(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

function statePaths(sessionId) {
  return {
    gate: path.join(STATE_DIR, `freshfiles-${sessionId}.json`),
    wrote: path.join(STATE_DIR, `assistantwrote-${sessionId}.json`),
    lastPrompt: path.join(STATE_DIR, 'freshfiles-lastprompt.json'),
  };
}

function scanNewFiles(roots, sinceMs, wroteMap, deadline) {
  const found = [];
  const stack = roots.filter(Boolean).map(r => ({ dir: r, depth: 0 }));
  while (stack.length) {
    if (Date.now() > deadline || found.length >= 200) break;
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      let mt;
      try { mt = fs.statSync(full).mtimeMs; } catch { continue; }
      if (mt <= sinceMs) continue;
      const wroteAt = wroteMap[norm(full)];
      if (wroteAt && mt <= wroteAt + 120000) continue;   // the assistant's own work is not hers
      found.push({ path: full, mtimeMs: mt });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, MAX_LIST);
}

function onPrompt(input) {
  const sid = input.session_id || 'unknown';
  const prompt = String(input.prompt || '');
  const cfg = readJson(CONFIG_PATH, null);
  const P = statePaths(sid);
  const now = Date.now();
  const last = readJson(P.lastPrompt, null);
  writeJson(P.lastPrompt, { t: now });
  if (!cfg || !Array.isArray(cfg.roots) || !last || !last.t) return null; // first run only stamps

  const wroteMap = readJson(P.wrote, {});
  const fresh = scanNewFiles(cfg.roots, last.t, wroteMap, now + SCAN_BUDGET_MS);
  if (fresh.length === 0) { writeJson(P.gate, { armed: false, pending: [] }); return null; }

  const nameHit = fresh.some(f =>
    prompt.toLowerCase().includes(path.basename(f.path).toLowerCase().slice(0, 24)));
  const armed = CUE_WORDS.test(prompt) || nameHit;
  writeJson(P.gate, { armed, pending: armed ? fresh.map(f => f.path) : [] });

  const lines = fresh.map(f => '  ' + f.path);
  return 'NEW OR CHANGED ON DISK SINCE THE PREVIOUS MESSAGE (not written by the assistant):\n'
    + lines.join('\n')
    + (armed
      ? '\nHER MESSAGE REFERENCES FILES. THE GATE IS ARMED: Edit and Write are BLOCKED until'
        + '\nevery file above has been opened (Read it, or list/extract its folder). Look first.'
      : '\nIf her message concerns any of these, read them before acting on recollection.');
}

function onPreTool(input) {
  const tool = input.tool_name || '';
  if (!/^(Edit|Write|NotebookEdit)$/.test(tool)) return null;
  const P = statePaths(input.session_id || 'unknown');
  const gate = readJson(P.gate, null);
  if (!gate || !gate.armed || !gate.pending || gate.pending.length === 0) return null;
  const listed = gate.pending.slice(0, 8).join('\n  ');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'FRESH FILES GATE: she referenced files and these are still unopened:\n  ' + listed
        + '\nRead each one (or list/extract its folder) before any edit. Her files outrank the plan.',
    },
  };
}

function onPostTool(input) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const P = statePaths(input.session_id || 'unknown');

  if (/^(Edit|Write|NotebookEdit)$/.test(tool)) {
    const fp = ti.file_path || ti.notebook_path;
    if (fp) {
      const wrote = readJson(P.wrote, {});
      wrote[norm(fp)] = Date.now();
      writeJson(P.wrote, wrote);
    }
    return;
  }

  const gate = readJson(P.gate, null);
  if (!gate || !gate.pending || gate.pending.length === 0) return;

  let touched = '';
  if (tool === 'Read') touched = norm(ti.file_path);
  else if (tool === 'Glob') touched = norm(ti.path || process.cwd());
  else if (tool === 'Bash' || tool === 'PowerShell') touched = norm(ti.command);
  if (!touched) return;

  const before = gate.pending.length;
  gate.pending = gate.pending.filter(p => {
    const np = norm(p);
    const dir = norm(path.dirname(p));
    const base = norm(path.basename(p));
    if (tool === 'Read') return np !== touched;
    // a command or glob that names the file, or its directory, counts as looking
    return !(touched.includes(np) || touched.includes(base) || (dir && touched.includes(dir)));
  });
  if (gate.pending.length !== before) {
    if (gate.pending.length === 0) gate.armed = false;
    writeJson(P.gate, gate);
  }
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { data += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const event = input.hook_event_name || '';
    if (event === 'UserPromptSubmit' || (!event && input.prompt !== undefined)) {
      const ctx = onPrompt(input);
      if (ctx) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
          suppressOutput: true,
        }));
      }
    } else if (event === 'PreToolUse' || (!event && input.tool_name && input.tool_response === undefined)) {
      const out = onPreTool(input);
      if (out) process.stdout.write(JSON.stringify(out));
    } else if (event === 'PostToolUse' || (!event && input.tool_name)) {
      onPostTool(input);
    }
  } catch { /* fail open, never break the session */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
