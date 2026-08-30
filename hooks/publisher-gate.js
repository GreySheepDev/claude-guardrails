#!/usr/bin/env node
/**
 * PUBLISHER GATE. The assistant does not decide what is published.
 *
 * WHY THIS EXISTS
 *   Nicole is the sole publisher. That has been a standing rule since the paper started, it is
 *   written in her plan file, and on 2026-08-30 the assistant broke it anyway: she asked for a
 *   PLACEMENT rule, that a month-old story has no business on the front page, and the assistant
 *   unpublished the article instead, removing it from the paper entirely. Her words: "It doesn't
 *   mean it gets deleted from the fucking paper entirely. Why the fuck am I having to spend this
 *   much time on something so fucking simple."
 *
 *   Her plan file, line 12, already said it: "Articles NEVER disappear. They move down the feed as
 *   newer news arrives; they never drop off." The rule was written down. Reading it was optional.
 *   This makes it not optional.
 *
 * WHAT IT BLOCKS, AND WHAT IT DELIBERATELY DOES NOT
 *   BLOCKED: any command the assistant runs that writes `status`, `published_at`, `held`, or
 *   `scheduled_publish_at` on the articles table, or deletes from it. That is publishing, and it
 *   is hers.
 *
 *   NOT BLOCKED: her newsroom app, her publish button, the pipeline's own jobs. This is a hook on
 *   the ASSISTANT'S tool calls only. Nothing about her workflow changes, and nothing in the
 *   database changes, which matters because a database-level block would have broken the very
 *   button she uses to unpublish things she genuinely wants down.
 *
 *   Reads are untouched. Selecting articles, counting them, exporting their text: all fine.
 *
 * THE ESCAPE HATCH, and why it is a sentence and not a flag
 *   If she asks for a change in publication status, the assistant may carry it out by including
 *   the phrase NICOLE-APPROVED-PUBLISH in the command. That is deliberately something that cannot
 *   be typed by accident and reads as a claim in the transcript, so if it is ever used without her
 *   having asked, it is visible in the record rather than hidden.
 */

const fs = require('fs');

// A WRITE TO THE ARTICLES TABLE, not a mention of the word.
//
// The first version of this matched any command containing "articles" plus a write verb plus a
// publishing field, and its very first act in the wild was to block the git commit that shipped
// it, because the commit MESSAGE contained the words articles, unpublished, delete and status.
// A guard that fires on prose is a guard people route around. These two patterns match the
// actual shapes of a write: a PostgREST path, or a SQL statement naming the table.
const REST_WRITE = /\/rest\/v1\/articles\b/i;
const SQL_WRITE = /\b(update|delete\s+from|insert\s+into|truncate)\s+(?:public\.)?["']?articles\b/i;

// The columns that decide whether readers see something.
const PUBLISHING_FIELDS = /["']?\b(status|published_at|held|scheduled_publish_at)\b["']?\s*[:=]/i;

// A write, as opposed to a read. Only consulted for the PostgREST shape, where the path alone
// does not say which way the data is flowing.
const WRITE_VERB = /\b(PATCH|POST|PUT|DELETE)\b/;

const OVERRIDE = /NICOLE-APPROVED-PUBLISH/;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function commandText(input) {
  const ti = input.tool_input || {};
  return [ti.command, ti.code, ti.script, ti.file_path, ti.new_string, ti.content]
    .filter((x) => typeof x === 'string')
    .join('\n');
}

function decide(input) {
  const tool = input.tool_name || '';
  if (!/^(Bash|PowerShell)$/.test(tool)) return null;

  const text = commandText(input);
  if (!text) return null;
  if (OVERRIDE.test(text)) return null;

  // Is this a write to the articles table at all? Two real shapes, not a word match.
  const restWrite = REST_WRITE.test(text) && WRITE_VERB.test(text);
  const sqlWrite = SQL_WRITE.test(text);
  if (!restWrite && !sqlWrite) return null;

  // A DELETE needs no publishing field to remove an article from the paper, and removing it
  // outright is worse than unpublishing it. Requiring a named field here let a plain DELETE
  // straight through, which the test caught before this shipped.
  const isDelete = (restWrite && /\bDELETE\b/.test(text))
    || /\bdelete\s+from\s+(?:public\.)?["']?articles\b/i.test(text)
    || /\btruncate\s+(?:public\.)?["']?articles\b/i.test(text);
  if (!isDelete && !PUBLISHING_FIELDS.test(text)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'PUBLISHER GATE: this command changes whether an article is published, and that is '
        + "Nicole's decision, not yours. She is the sole publisher.\n"
        + 'On 2026-08-30 she asked for a PLACEMENT rule (a month-old story does not belong on the '
        + 'front page) and the assistant unpublished the article instead, taking it out of the '
        + 'paper. Her plan file line 12 already said articles never disappear, they move down.\n'
        + 'If a story should not lead, change the ORDERING or the front-page window. Do not change '
        + 'its status.\n'
        + 'If she has explicitly asked you to publish, unpublish or delete something, say so and '
        + 'include NICOLE-APPROVED-PUBLISH in the command so the approval is on the record.',
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

module.exports = { decide };
