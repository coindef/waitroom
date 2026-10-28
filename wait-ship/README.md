# wait-ship

<img src="./.claude-plugin/icon.svg" width="56" align="right" alt="wait-ship's icon: an outbox with an arrow rising out of it">

One of four rooms in [waitroom](../README.md#one-family-four-rooms):
[wait-review](../wait-review) (the diff) ·
[bet-on-your-agent](../bet-on-your-agent) (your calibration) ·
**wait-ship (what ships)** · [wait-breathe](../wait-breathe) (you).

A Claude Code plugin that drafts the words around the turn's changes — the
commit message, the PR description, the changelog entry — the moment the
turn lands, so you can review them the way `wait-review` lets you review the
diff itself.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-ship@waitroom
```

(Each as its own message; both are safe to send again. Needs Claude Code
2.1.291 or later; `claude update` if `claude --version` says otherwise.)

## Why drafts, not a tool call

An agent can already write a commit message. What it cannot do unprompted is
hand you something to read, correct, and use on your own time — so this reads
the diff the turn already wrote, the same diff `wait-review` reads, and turns
it into three things worth looking at before you ship: a commit message, a PR
description, and — only where one applies — a changelog entry.

It never runs `git commit`, never runs `gh`, never touches `CHANGELOG.md`. It
writes drafts to their own folder and tells you the exact command to run if
you want them. The ship is still yours.

## What it does

When a turn ends having changed anything, the row above the prompt — the same
one `bet-on-your-agent` uses — offers the kit it drafted:

<img src="../docs/ship-offer.svg" width="600" alt="The row above the prompt: a green ship tag, Drafts ready: Update 2 files · commit 61B · PR 180B · changelog 55B, then a: Accept all  m: More  s: Skip, then ctrl+x tab to use these keys · or click them · read each draft before using it">

*A real capture (Claude Code 2.1.311), not a mockup: the kit for a two-file
change in a scratch repository.*

**The keys are letters, so give the row the keys first** — `ctrl+x tab`, or a
click, as the row's own last line says, in the same words wait-review's pane
uses — then press one. A letter typed into the composer stays in the
composer; only `bet-on-your-agent`'s digits 1 to 5 answer from there.

- **`a` accepts every drafted artifact.**
- **`s` skips.** Nothing is written, and the row goes quiet.
- **`m` (More) puts each draft on a key of its own**, in place: `c` writes
  just the commit message, `p` just the PR body, `l` just the changelog entry,
  and `e` writes the same drafts as `a`, framed for editing rather than for
  immediate use — all of them are called drafts either way. Most offers are
  answered with `a` or `s`, so those are all the row shows until you ask.
- Accepted drafts are written under `shipDir` (`.waitroom/ship` by default):
  `COMMIT_EDITMSG.txt`, `PR_BODY.md`, `CHANGELOG_ENTRY.md`. One line per draft
  in the transcript says exactly what to run, and the row is free again at
  once:

```
wait-ship: Draft written: .waitroom/ship/COMMIT_EDITMSG.txt — git commit -F .waitroom/ship/COMMIT_EDITMSG.txt
wait-ship: Draft written: .waitroom/ship/PR_BODY.md — gh pr create --body-file .waitroom/ship/PR_BODY.md
```

- The drafts folder ignores itself: the first time it writes there, it adds a
  `.gitignore` of `*` (never over one you already have, and never when
  `shipDir` is the repository root). So drafts stay out of `git status`, out of
  `wait-review`'s queue, and out of the next kit's diff.

Nothing here is ever executed on your behalf — not the commit, not a `gh`
call, not an edit to `CHANGELOG.md`. The transcript names the command; you
decide whether to run it.

**No changes, no row.** A turn that changed nothing leaves this plugin
completely silent — even when earlier changes are still sitting uncommitted in
the tree, since those were offered when they were made (or were there before
the session began). **Outside a git repository**, same thing — there is no
diff to draft from.

The row is shared, and shows one mod at a time: a `wait-breathe` nudge comes
first, then — between turns, when that mod is installed and the turn changed
files — `wait-changed`'s read-only list, then this kit, then
`bet-on-your-agent`'s "Did it land?", which takes the row the moment the kit
is answered.

## What goes into each draft

- **Commit message.** The subject line is derived from the files changed:
  which ones, where, and roughly what kind of change they look like (a new
  file reads as a feature, an all-test diff reads as `test`, and so on) —
  guessed from the diff alone, since this is deterministic text generation,
  not a model call. It looks at your last 20 commit subjects first: if most
  of them are conventional commits (`type(scope): subject`), it writes one of
  those; otherwise it matches the prevailing capitalization and tense
  instead. The body is short bullets, grouped by area once the diff touches
  more than one.
- **PR description.** `## Summary` (2-4 bullets on what changed and roughly
  why, read off the files — a diff carries no rationale a deterministic pass
  can honestly invent), `## Changes` (the same per-area bullets as the commit
  body), `## Test plan` (a checkbox per test file the diff touched, plus one
  manual-verification line always).
- **Changelog entry**, only when `CHANGELOG.md` exists in the repository
  root and `includeChangelog` is on: 1-2 bullets under `### Added`, `###
  Changed` or `### Fixed`, picked the same way the commit type is. It is a
  standalone snippet to paste in yourself — this plugin never edits
  `CHANGELOG.md`.

## Settings

| Option | Default | What it means |
| --- | --- | --- |
| `enabled` | `true` | Draft a kit at the end of each turn that changed anything. |
| `shipDir` | `.waitroom/ship` | Repository-relative folder accepted drafts are written into; a folder of its own gets a `.gitignore` of `*`. |
| `includeChangelog` | `true` | Draft a changelog entry when `CHANGELOG.md` exists. |

## What it does not do

- **No network, no `gh`, no git write of any kind.** Reading the diff and the
  recent log is the only git it runs.
- **No model call.** Every word is generated by a fixed, deterministic pass
  over the diff — the same input always produces the same draft.
- **It does not guess at your reasons.** The "why" in a PR summary is limited
  to what kind of change it is and where — a diff alone cannot honestly say
  more than that.
- **It never executes what it prints.** The apply commands are text. Running
  them is always a separate, deliberate step you take.

## Developing

```
claude plugin validate .     # manifest and hooks, as the engine reads them
claude plugin test .         # 70 tests
```

The diff parsing, style inference and every drafted artifact live in
`hooks/ship.ts` with no engine dependency and are tested directly against
fixture diffs and fixture commit histories. `hooks/register.tsx` is the hooks
module; `types/index.d.ts` is the state contract. `tests/flow.test.tsx` drives
the whole loop through the engine, with git and the filesystem answered by the
test — including a turn with no changes, a turn that changed nothing in an
already-dirty tree, one outside a repository, and each of the band's keys
actually writing (or not writing) the right files.
