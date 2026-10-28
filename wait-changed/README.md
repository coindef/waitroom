# wait-changed

<img src="./.claude-plugin/icon.svg" width="56" align="right" alt="wait-changed's icon: three lines of a list">

A Claude Code plugin that, once a turn ends, lists the files that turn
changed. Read-only, local git, and easy to turn off.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-changed@waitroom
```

(Each as its own message; both are safe to send again. Needs Claude Code
2.1.291 or later; `claude update` if `claude --version` says otherwise.)

## What it does

When a turn ends having changed files, the row above the prompt — the same
one `bet-on-your-agent` and `wait-ship` use, under the transcript rather than
over Claude's reply — shows one card:

- **Title:** `What changed this turn`
- **Subtitle:** `Read-only local git — nothing uploaded`
- **Up to eight files**, each a path and a short hint: `+12 −3`, or `added`,
  `deleted`, or `modified` when the change has no line count. Anything past
  eight is one line, `N more files…` (`1 more file…` when only one is left).
  No hunks.
- **`Close`** dismisses this turn's card. The next turn that changes files can
  show its own.
- **`Don't show again`** turns the card off.

It is not drawn while a turn is still running. A turn that changes nothing,
including one that leaves pre-existing dirt untouched, draws nothing. Outside
a git repository, or if `git` cannot be read, it stays silent.

The row shows one mod at a time. This card comes ahead of a `wait-ship` offer
and `bet-on-your-agent`'s "Did it land?", and `Close` is what gives them the
row. A `wait-breathe` nudge, which is only up while a turn runs, still comes
first.

Nothing here writes a file, runs `git commit`, or opens a network request.

## Turn it back on

**On until you turn it off.** Send `/wait-changed` to turn it back on. The
same switch is *Show a turn-end diff card* under `/plugin` → wait-changed. If
the card stays hidden after that switch reads as on, send `/wait-changed`
once — a local preference is holding it off, which is what `Don't show again` keeps
when the setting itself could not be saved.

## Developing

```
claude plugin validate .
claude plugin test .
```

The engine-free logic is `hooks/changed.ts`. The card is drawn from
`hooks/register.tsx` on `turn.complete` only.
