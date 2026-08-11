# claude-guardrails

Harness-level guardrails for Claude Code. They exist because writing a rule down, even in a file the
model reads at startup, is not enough to make the rule hold.

## The problem this solves

A long working session degrades. The rules are loaded once, at the beginning, and after a few hundred
messages the recent text dominates attention while the rules sit far away and unread. The result is a
specific and expensive failure pattern:

- work reported as finished after verifying one thing, at one moment, on a path the model controlled
- symptoms patched repeatedly instead of the underlying model being fixed
- shortcuts taken silently, so the person paying for the work cannot even ask about them
- promises to do better, which never survive to the next session

That last point is the crux. **The model cannot fix this by intending to.** Nothing it decides in one
session carries to the next. Only two things persist: files, and mechanisms the harness executes.
These hooks are the second kind. They run whether or not the model is paying attention.

## What it installs

**A global `CLAUDE.md`** in `~/.claude/`, loaded in every project on the machine, holding the working
agreement itself. Project-scoped memory does not load when you open a different folder; this does.

**`governing-rules.js`** on `UserPromptSubmit`. Re-injects the core rules into context on every single
message, so they occupy the most recent position rather than decaying into the distance. It also
escalates: past 60 turns and again past 120, it names the session length and says plainly that this
is where things have gone wrong before.

**`work-ledger.js`** on `PostToolUse`. Counts file changes since anything was actually verified. Every
Edit or Write increments it; only a command that could genuinely demonstrate something (a request, a
test run, a build, a query) resets it. The count is reported back on the next turn, so a claim that
something works has to be made with the number of unverified changes visible. This is the mechanical
form of "state what you did not check."

**`pre-ship-check.js`** on `PreToolUse`. Fires at the exact moment work goes outward (`git push`,
`systemctl restart`, `terraform apply`, and similar) with the verification standard: check from the
position a real user occupies, reason across time and state rather than one instant, and report what
was not checked. It deliberately does not block. The goal is transparency, not obstruction.

## Install

```bash
bash install.sh
```

It copies the hooks to `~/.claude/hooks/` and self-tests them. It does **not** edit your
`settings.json`; it prints the block for you to merge. Silently rewriting how every future session
behaves is precisely the kind of judgment-substitution this repo exists to prevent, so a human makes
that call. Copy `CLAUDE.md.template` to `~/.claude/CLAUDE.md` and edit it to taste.

Hooks are installed to `~/.claude/hooks/` rather than run from this repo because hook commands run
through a shell, and a repo path containing a space is a dependable source of quoting bugs.

## Design constraints

**A guardrail must never break a session.** Every hook catches all errors, always emits valid JSON,
and always exits 0. A hook that crashes is worse than no hook, because it damages the work it was
meant to protect.

**No dependency on `jq`.** Every published hook example uses it and it is frequently absent. These are
written in Node, which ships with any machine already running Claude Code.

**The logic lives in reviewable files, not in config.** A regex buried in `settings.json` cannot be
version controlled, diffed, or tested. These can, and are.

## Tests

```bash
bash tests/run-tests.sh
```

The suite is deliberately hostile: malformed JSON, empty stdin, missing fields. Since these hooks sit
in the path of every message and every command, the bar is not "works on the happy path" but "cannot
break a session." The verification classifier is tested directly against commands that prove something
and commands that prove nothing, because that distinction is where the real judgment lives.

## Honest limits

- **Claude Code on this machine only.** It does not reach claude.ai, the mobile apps, or any other
  surface. The equivalent lever there is account-level custom instructions.
- **Injection is not obedience.** These mechanisms guarantee the rules are *present* and that the
  unverified-work count is *visible*. They cannot guarantee the model acts on either. They remove the
  excuse of forgetting; they do not remove the possibility of ignoring.
- **The verification classifier is a heuristic.** It will miss project-specific test commands. When it
  does, add the pattern. One such gap surfaced within minutes of first real use: running a test suite
  as `bash tests/run-tests.sh` did not count, and had to be added.

## Origin

Built after a long session in which the same failures recurred despite every one of them already being
written down. The rules were known. The mechanism to keep them in view was missing.
