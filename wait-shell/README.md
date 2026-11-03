# wait-shell

Part of [waitroom](../README.md#plugins).

While Claude thinks, see the shell commands it ran this turn. Runs locally, read-only. Spot the surprise `npm i` before you ship.

A Claude Code plugin that lists the commands a turn runs through the Bash
tool. **wait-changed shows the files a turn changed; wait-shell shows the
commands it ran.** It never blocks a command.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-shell@waitroom
```

This install stays on its own. The four rooms are `/plugin install waitroom@waitroom`.

## What it shows

- **While the turn runs.** The status line counts each command as it
  finishes: `1 shell command`, then `3 shell commands`. Nothing at 0.
- **The list.** The row above the prompt lists the commands, one per row,
  newest last:

  ```
  $ ls
  $ git status
  $ npm i                                                        error
  ```

  A word on the right says how a command came back: `error`, `stopped`, or
  `background`. A command that finished has none. The list cuts a long
  command at 200 characters and shows each line break inside one as `↵`. It
  holds eight rows; past that, it shows the newest eight under a line that
  counts the rest, `N earlier commands…`. A short terminal gets fewer rows,
  still the newest.
- **After the turn.** The list and the count stay up until you close them or
  the next turn starts. `Close` puts both away for the rest of the turn;
  `Don't show again` turns the plugin off.

## What it counts

Every Bash call in the turn, from Claude and from any subagent it starts, in
the order they finish. A call a hook refused never ran, so the list leaves it
out. A call that came back as an error stays in, marked `error`: the command
exited non-zero, or the permission check turned it down. Once the turn ends,
only a subagent that is still running adds to the list.

## Sharing the row

The row above the prompt shows one plugin at a time, and this list comes
last. A wait-breathe nudge or a bet-on-your-agent forecast keeps the row
while a turn runs. Between turns, a wait-changed, wait-ship,
bet-on-your-agent, wait-scope or wait-secret card keeps it. The status line
still shows the count while the list waits.

## Limits

It sees the Bash tool and nothing else. Edit and Write change files without a
shell command; wait-changed lists those files. It shows the command, not what
the command did or printed.

## What it never does

It never blocks, rewrites, reruns or stops a command. The call goes on as
Claude wrote it, and its answer comes back as the shell gave it. It runs no
process of its own, writes no file, makes no network call, and sends no
telemetry. Its one write is its own on or off switch, when you press
`Don't show again` or send `/wait-shell`.

`/wait-shell` turns it off, and the next `/wait-shell` turns it back on. The
same switch is *List the shell commands a turn ran* under `/plugin` →
wait-shell.

## Develop

```sh
claude plugin validate ./wait-shell
claude plugin test     ./wait-shell   # 37 tests
```

The logic that needs no engine is [hooks/shell.ts](hooks/shell.ts); the hooks
are in [hooks/register.tsx](hooks/register.tsx).
[tests/flow.test.tsx](tests/flow.test.tsx) drives whole turns through the
engine and checks that no call is blocked or rewritten, and that nothing is
run, written or fetched.
