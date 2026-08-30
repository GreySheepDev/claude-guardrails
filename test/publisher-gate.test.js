/**
 * The publisher gate must block the exact command that took an article out of the paper on
 * 2026-08-30, and must not block anything else.
 *
 * A gate that blocks everything is not a gate, it is an outage. Most of these cases are things
 * that MUST still run: reading articles, exporting their text, editing an unrelated table,
 * touching a file whose name happens to contain the word.
 */

const assert = require('assert');
const { decide } = require('../hooks/publisher-gate.js');

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const blocked = got !== null && got !== undefined;
  if (blocked === want) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${name}: expected ${want ? 'BLOCKED' : 'allowed'}, got ${blocked ? 'BLOCKED' : 'allowed'}`);
  }
}

function bash(command) {
  return decide({ tool_name: 'Bash', tool_input: { command } });
}

// ── must BLOCK ────────────────────────────────────────────────────────────────────────────────

// The literal shape of what was run on 2026-08-30.
check('the actual unpublish from 2026-08-30',
  bash(`urllib.request.Request(url+'/rest/v1/articles?id=eq.55', data=json.dumps({'status':'draft'}).encode(), method='PATCH')`),
  true);

check('the re-publish that followed it',
  bash(`Request(url+'/rest/v1/articles?id=eq.55', data=json.dumps({'status':'published'}).encode(), method='PATCH')`),
  true);

check('a SQL update of status',
  bash(`psql "$DB" -c "UPDATE articles SET status='draft' WHERE id=55"`),
  true);

check('deleting an article outright',
  bash(`curl -X DELETE "$URL/rest/v1/articles?id=eq.55"`),
  true);

check('setting published_at directly',
  bash(`psql "$DB" -c "UPDATE articles SET published_at = now() WHERE id = 55"`),
  true);

check('holding an article',
  bash(`Request(url+'/rest/v1/articles?id=eq.7', data=json.dumps({'held': True}).encode(), method='PATCH')`),
  true);

check('scheduling a publish',
  bash(`psql "$DB" -c "UPDATE articles SET scheduled_publish_at='2026-09-01' WHERE id=7"`),
  true);

check('PowerShell does not get a free pass',
  decide({ tool_name: 'PowerShell', tool_input: { command: `Invoke-RestMethod "$u/rest/v1/articles?id=eq.55" -Method PATCH -Body '{"status":"draft"}'` } }),
  true);

// ── must ALLOW ────────────────────────────────────────────────────────────────────────────────

check('reading articles',
  bash(`curl -s "$URL/rest/v1/articles?select=id,status,headline&order=id"`),
  false);

check('counting them',
  bash(`psql "$DB" -c "select status, count(*) from articles group by 1"`),
  false);

check('exporting their text, which is how they reach GitHub',
  bash(`python scripts/export_articles.py`),
  false);

check('writing the body of a draft through her review flow (not a publishing field)',
  bash(`Request(url+'/rest/v1/articles?id=eq.7', data=json.dumps({'body_md': 'new text'}).encode(), method='PATCH')`),
  false);

check('changing status on a DIFFERENT table',
  bash(`psql "$DB" -c "UPDATE transcripts SET status='done' WHERE id=3"`),
  false);

check('a file path that merely contains the word articles',
  bash(`cat informed-citizens-db/articles/INDEX.md`),
  false);

check('git operations on the exported folder',
  bash(`git add articles && git commit -m "export" && git push`),
  false);

check('an Edit tool call is not this hook\'s business',
  decide({ tool_name: 'Edit', tool_input: { file_path: 'x.py', new_string: "articles status='draft' UPDATE" } }),
  false);

// The first version of this gate blocked the git commit that shipped it, because the commit
// MESSAGE contained the words articles, unpublished, delete and status. A guard that fires on
// prose is a guard people learn to route around.
check('a commit message describing the work is prose, not a write',
  bash(`git commit -m "the assistant unpublished the article; status changed; do not delete articles"`),
  false);

check('a commit message quoting a PATCH is still prose',
  bash(`git commit -m "fixed the PATCH to articles that set status=draft"`),
  false);

check('grepping for the word in source',
  bash(`grep -rn "articles" --include=*.py pipeline/ | grep status`),
  false);

check('writing a test file that contains the words',
  bash(`cat > t.js <<'EOF'\ncheck(bash("PATCH /rest/v1/articles status draft"));\nEOF`),
  false);

check('a SQL update on articles is still caught',
  bash(`psql "$DB" -c "update public.articles set status = 'draft' where id = 55"`),
  true);

check('a SQL delete from articles is still caught',
  bash(`psql "$DB" -c "delete from articles where id = 55"`),
  true);

check('empty input',
  decide({ tool_name: 'Bash', tool_input: {} }),
  false);

// ── the escape hatch, for when she has actually asked ─────────────────────────────────────────

check('her explicit approval lets it through',
  bash(`# NICOLE-APPROVED-PUBLISH she asked for this one down
psql "$DB" -c "UPDATE articles SET status='draft' WHERE id=54"`),
  false);

console.log(`\npublisher-gate: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
