# wait-review

A Claude Code plugin that turns the wait while Claude works into incremental
review of the diff it has already written.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-review@waitroom
```

(Each as its own message; both are safe to send again. Needs Claude Code
2.1.291 or later; `claude update` if `claude --version` says otherwise.)

## Why this and not a loading-screen game

The cost of waiting on a coding agent is not boredom, it is context collapse. A
90-second wait filled with something entertaining costs minutes of refocus on
the way back, and any game with a win condition quietly teaches you to want the
agent to be slow. You also cannot win on entertainment: the person already has
a phone.

Meanwhile a real problem is getting worse. The agent writes code faster than
anyone reads it, so a session ends with a 600-line diff nobody will ever review
properly.

So the wait is spent on the diff the agent already wrote. Same mental context,
naturally chunked, interruptible at any moment, and at the end of the session
the diff has been reviewed at no dedicated review cost.

## What it does

- At the end of each turn, reads the repository's whole diff against the commit
  the session started on, and queues each hunk as its own review card.
- Leaves out whatever was already uncommitted when the session began, so your
  own work in progress is never offered as the agent's review.
- Shows one card at a time in a pane, in reading order — each file together,
  top of the file first. Give it the keys with `/wait-review` or `ctrl+x tab`
  (or click it), then `o` looks right, `f` flag, `l` later, `x` skip the rest
  of this file, `u` undo. A hunk longer than the pane pages with `j` and `k`.
- After flagging, `n` opens a box to say why, and that reason goes to Claude
  with the hunk. Optional: flagging stays one press and the box only appears
  when you ask for it.
- Keeps a count on the status line, so an unread diff is visible without
  opening anything.
- Sends what you flagged to Claude as review notes attached to your next
  message, as the diff you were looking at when you flagged it.

That last step closes the loop: you read during the wait, flag what is wrong,
and the correction rides along with whatever you type next. No extra turn.

## Combo and session grade

Deciding a hunk — `o`, `f` or `l` — without an intervening `x` builds a combo,
shown as `combo x5` once it reaches three; skipping a file breaks it back to
nothing. The session keeps count of hunks read, flagged and skipped, and the
longest combo reached, and grades the session on how much of what was
resolved was actually read rather than waved away in bulk: `S` needs at least
90% read and one flag, `A` 75%, `B` 50%, else `C`. Both show in the pane and
in `/wait-review`'s reply, and an undo reverses them along with the hunk.

## Commands

| Command | What it does |
| --- | --- |
| `/wait-review` | Opens the pane and re-reads the diff now |

## Settings

Set these in the config menu, or under `pluginConfigs` in settings.

| Option | Default | What it means |
| --- | --- | --- |
| `ignore` | built-in list | Comma-separated globs whose hunks are never queued. Empty uses the built-in list. |
| `contextLines` | `3` | Lines of context around each hunk (`git --unified`). |
| `autoOpen` | `true` | Open the pane when the session starts. |
| `attachFlags` | `true` | Attach flagged hunks to your next message. |

A hunk's id is a hash of its own text. When Claude rewrites a region you already
marked reviewed the id changes, so the hunk returns to the queue as a new card
rather than staying silently approved — and a hunk it reverted, or you
committed, leaves the queue on the next scan.

## Files it leaves alone

Agents regenerate lockfiles, build output and snapshots, and one regenerated
lockfile is otherwise forty hunks of noise ahead of the code that matters. So
these are never queued:

```
lockfiles (npm, pnpm, yarn, bun, cargo, poetry, composer, bundler, go.sum)
node_modules/ dist/ build/ out/ target/ .next/ coverage/
__snapshots__/ *.snap *.min.js *.min.css *.map
```

Set `ignore` to your own comma-separated globs to replace that list. `*` stays
inside one path segment, `**` crosses them, and a leading `**/` matches a
relative or an absolute spelling of the same file.

## Why it reads git rather than watching edits

It used to build the queue from `Edit`, `Write` and `NotebookEdit` calls. That
was wrong, and only using it showed how wrong: an agent that writes through a
shell heredoc, `sed` or a script makes no such call, so nothing was ever queued
and the pane sat empty through a session that rewrote eight files. Some agents
are told to prefer the shell for edits, which made the mod useless for them.

git is the only witness that cannot be fooled, so the scan reads the whole
repository diff and does not care how a file came to be written. The cost is
that your own uncommitted work would be in that diff too, which is what the
session-start snapshot is for.

## Where the pane goes

A pane nobody asked for is only placed from 144 columns, so on a narrower
terminal it waits until you ask. When that happens the status line says so:

```
wait-review: 3 to read · open with /wait-review
```

Running `/wait-review` places it at any width, and it takes the keyboard too —
the hotkeys answer right away, no click or `ctrl+x tab` needed first. Once
you've opened it that way and not closed it by hand, the floor for the
unasked, auto-opened-at-start pane drops from 144 columns to 110 for the rest
of this session and any after — the terminal does not need to be as wide once
you've shown you want it.

### Claude Code's own diff panel

Claude Code 2.1.304 added a diff panel of its own, which opens beside the
transcript the first time Claude edits and sits in front of this pane while it
is up. Send `/diff` once to hide it: Claude Code remembers the choice across
sessions, so the side is this pane's from then on, and `/diff` brings the
built-in panel back whenever you want it. The two answer different questions —
the panel shows what changed, this pane asks whether each change is right and
sends what you flag back to Claude.

The pane list Claude Code gives plugins still calls this pane shown while the
diff panel covers it, so the status line cannot tell. `/wait-review` can: it
asks for the keyboard, and when that does not arrive its reply says the diff
panel is in front.

## Giving it the keys

The pane's letters only work while it holds the keyboard. Press `o` without that
and an `o` goes into your prompt instead, so the pane says which it is at the
bottom: `/wait-review or ctrl+x tab to use these keys · or click them` while it
does not have them, and `esc hands the keys back to the prompt` while it does.

`/wait-review` always gives it the keys. `ctrl+x tab` does too, except while a
row above the prompt has buttons up — bet-on-your-agent asking "Did it land?",
say — when it gives the keys to that row instead. Answer the row, or use
`/wait-review`.

## Long hunks

A new file is a single hunk as long as the file. Rather than cutting it at the
pane's height — which meant a new file could never be read past its first
screen — the pane pages: `lines 1–30 of 200`, `j` to read on, `k` to read back.
Every page is drawn as a hunk of its own, with a header rewritten to match, so
it still draws as a diff. Reading to the end is not required before deciding.

## What the pane looks like

<img src="../docs/paging.svg" width="480" alt="The review pane mid-page through src/retry.ts, lines 1 to 17 of 29, controls lit, one hunk flagged">

A real capture. The header carries the pane's name, a bar that fills as you
read, and the counts — counts that are zero are left out. Under it, the hunk's
`path:line` and its `+`/`−` counts, then the diff. Each control carries its own
key, so there is no legend to learn, and the controls are dim until the pane
holds the keyboard: lit, `Looks right` is green and `Flag` amber, so a glance
says where a letter will land. Read to the end and it says `✓ All caught up`.

## Saying why

Flagging sends the hunk. Pressing `n` after it adds your reason, which arrives
with the diff:

```
src/auth.ts @@ -10,3 +10,3 @@
they said: this drops the retry on every 5xx
```

The box asks `Why flag src/auth.ts:10?` in an amber frame, and the flagged hunk
stays on screen under it while you type, though the card behind it has moved
on. Until the flag goes out, an amber bar under the controls says how many are
flagged and that they go to Claude with your next message.

It is a mode on purpose. A focused field takes the keys that would otherwise be
`o`, `f` and `l`, so the box is only up while you want it, and Enter on an empty
box means the diff speaks for itself.

Mostly you will not need it — the flagged hunks ride along with your next
message, so you can simply type the reason there. The box earns its place when
you have flagged several hunks and the reasons differ. On a surface that draws
no text field (the mobile app today) it is not offered, and typing the reason
into your message is the fallback.

## What it does not do

- **No git, no review.** The queue is built from `git diff HEAD`, so outside a
  repository the pane stays empty. Untracked files are picked up separately,
  via `git diff --no-index`.
- **The base is where the session started**, not current `HEAD`. An agent
  commits on your behalf, often before you have read a line, and against
  current `HEAD` that silently empties the queue of everything it just
  committed. A commit is not a review, so the anchor is taken once at session
  start; under a rebase or reset that loses it, the scan falls back to `HEAD`.
- **It does not block anything.** Every hook that sits at a gating site passes
  the call through if the plugin itself fails, so a bug here can never swallow
  your prompt or an edit.
- **No canned reasons.** The note is free text or nothing. A picker of
  "wrong / risky / unclear" would add a keystroke to tell the agent something it
  can usually work out once the hunk is in front of it.

## Developing

```
claude plugin validate .     # manifest and hooks, as the engine reads them
claude plugin test .         # 78 tests
```

The logic that does not need the engine lives in `hooks/diff.ts` (diff parsing,
hunk trimming, queue merging) and is tested directly. `hooks/register.tsx` is
the hooks module; `types/index.d.ts` is the state contract that
`claude plugin validate` holds it to.

`tests/flow.test.ts` drives the whole loop through the engine with git answered
by the test — `$.process.run` is an event like any other — so the scan is
exercised rather than mocked away. Its first test makes no tool call at all,
which is the regression for the bug above.

Run a working copy without installing it:

```
claude --plugin-dir /path/to/Plugin
```
