# wait-review

A Claude Code plugin that turns the wait while Claude works into incremental
review of the diff it has already written.

```
/plugin install wait-review --marketplace coindef/Plugin
```

(Answer `y` to add the marketplace, then pick a scope.)

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

- Watches `Edit`, `Write` and `NotebookEdit` and remembers which files Claude
  touched, and when.
- At the end of each turn, re-reads `git diff` for those files and queues each
  hunk as its own review card.
- Shows one card at a time in a pane, in reading order — each file together,
  top of the file first. Press `o` (looks right), `f` (flag), `l` (later),
  `x` (skip the rest of this file), `u` (undo the last call).
- Keeps a count on the status line, so an unread diff is visible without
  opening anything.
- Sends what you flagged to Claude as review notes attached to your next
  message, as the diff you were looking at when you flagged it.

That last step closes the loop: you read during the wait, flag what is wrong,
and the correction rides along with whatever you type next. No extra turn.

## Commands

| Command | What it does |
| --- | --- |
| `/wait-review` | Opens the pane and re-reads the diff now |

## Settings

Set these in the config menu, or under `pluginConfigs` in settings.

| Option | Default | What it means |
| --- | --- | --- |
| `settleTurns` | `0` | Turns a file must go untouched before its hunks are offered. `0` offers them at the end of the turn that wrote them. |
| `ignore` | built-in list | Comma-separated globs whose hunks are never queued. Empty uses the built-in list. |
| `contextLines` | `3` | Lines of context around each hunk (`git --unified`). |
| `autoOpen` | `true` | Open the pane when the session starts. |
| `attachFlags` | `true` | Attach flagged hunks to your next message. |

`settleTurns: 0` is a safe default because a hunk's id is a hash of its own
text. When Claude rewrites a region you already marked reviewed, the id changes
and the hunk returns to the queue as a new card, so surfacing eagerly costs
nothing. Raise it to `1` or `2` if you would rather read each region once the
agent has clearly moved on.

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

## Where the pane goes

A pane nobody asked for is only placed from 144 columns, so on a narrower
terminal it waits until you ask. When that happens the status line says so:

```
review: 3 to read · /wait-review
```

Running `/wait-review` places it at any width.

## What it does not do

- **No git, no review.** The queue is built from `git diff HEAD`, so outside a
  repository the pane stays empty. Untracked files are picked up separately,
  via `git diff --no-index`.
- **Uncommitted work only.** `HEAD` is the base, which is the right one while
  the agent's work is uncommitted. Once you commit, those hunks leave the queue.
- **It does not block anything.** Every hook that sits at a gating site passes
  the call through if the plugin itself fails, so a bug here can never swallow
  your prompt or an edit.
- **No comment box on a flag.** Flagging sends the hunk, not a reason. A
  one-line note would be better and is the next thing worth adding; a picker of
  canned reasons would not, since the agent can usually see what is wrong once
  the hunk is in front of it.

## Developing

```
claude plugin validate .     # manifest and hooks, as the engine reads them
claude plugin test .         # 34 tests
```

The logic that does not need the engine lives in `hooks/diff.ts` (diff parsing,
hunk trimming, queue merging) and is tested directly. `hooks/register.tsx` is
the hooks module; `types/index.d.ts` is the state contract that
`claude plugin validate` holds it to.

Run a working copy without installing it:

```
claude --plugin-dir /path/to/Plugin
```
