# wait-notify

<img src="./.claude-plugin/icon.png" width="56" align="right" alt="wait-notify's icon: a bell">

A Claude Code plugin that sends a native macOS notification when Claude is
blocked on you and you're not at the terminal: a permission it is waiting on,
or a question it asked. One reminder after 3 minutes, then quiet. macOS only.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-notify@waitroom
```

This install stays on its own. It is not part of `waitroom@waitroom`.

## What it does

Claude Code raises its `Notification` hook when it has been waiting on you.
wait-notify answers two kinds:

| Claude Code sends | The notification says |
| --- | --- |
| `permission_prompt`: a permission dialog has waited | `Waiting on a permission` |
| `permission_prompt` while an `AskUserQuestion` call is open, or `elicitation_dialog` | `Asked you a question` |

The title is `Claude needs you`.

- **You are at the terminal:** nothing is sent.
- **You are away:** the notification goes out at once.
- **3 minutes later:** if Claude is still blocked and you are still away, one
  reminder, `Still waiting · 3 min`. Never a second one.

A turn that ends is silent, unless `notify_on_stop` is on (below).

## Which notifications count

- **`permission_prompt`.** Claude Code sends it once a permission dialog has
  waited a few seconds with no input.
- **A question from Claude.** Claude asks with the `AskUserQuestion` tool, and
  Claude Code sends the same `permission_prompt` for that dialog (with the same
  text, `Claude needs your permission`). wait-notify watches tool calls to tell
  the two apart: while an `AskUserQuestion` call is open, the body is
  `Asked you a question`.
- **`elicitation_dialog`.** An MCP server's question that Claude is blocked on.
- **Not `idle_prompt`.** Claude Code sends that once a *finished* turn has sat
  idle for a while, which is every turn end. A turn end stays silent here.
- **Not the rest:** `auth_success`, `elicitation_url_dialog`,
  `agent_needs_input`, `agent_completed`, `worker_permission_prompt`,
  `plugin_notification` and anything newer send nothing, and run nothing.

## Are you at the terminal?

Both have to hold:

1. `ioreg -c IOHIDSystem` reports a `HIDIdleTime` (nanoseconds since your last
   key or mouse event) under `present_idle_secs`, 30 by default.
2. The frontmost app is Terminal, iTerm2, Ghostty, VS Code or Cursor:

   ```sh
   osascript -e 'POSIX path of (path to frontmost application)'
   ```

   That is a Standard Additions command, not a System Events query, so it
   should not raise an Automation permission prompt.

The idle check runs first; past the threshold, the frontmost app is not asked.
A check that fails, or prints something unreadable, counts as away. A
notification you did not need beats a wait nobody hears about.

## The reminder

`remind_after_min` (3) minutes after the notification, the presence check runs
once more. If you are still away, the reminder goes out. Either way, that wait
is finished: no further reminder.

These cancel the reminder as soon as they happen:

- a prompt you send (typed, or from your phone or the web; a task
  notification or another session's message is not you)
- a tool call that was already running when the notification went out
  finishing, which is Claude going on after your answer
- the main turn ending, answered or with Esc (a subagent finishing does not
  count)
- your answer to an MCP server's question
- the session ending, `/clear` included

Being back at the terminal at the recheck cancels it too.

Claude Code raises no event when you answer a permission dialog, only when
that tool call finishes. So a long command you allowed counts as still waiting
until it finishes. If you allowed it and then walked away while it ran, the
recheck can still send its one reminder.

## Config

`~/.waitroom/notify.json`, every key optional:

```json
{ "present_idle_secs": 30, "remind_after_min": 3, "notify_on_stop": false }
```

| Key | Default | What it means |
| --- | --- | --- |
| `present_idle_secs` | `30` | Under this many seconds idle, with a terminal in front, you count as present. |
| `remind_after_min` | `3` | Minutes from the notification to the one reminder. The reminder's text says this number. |
| `notify_on_stop` | `false` | Also notify when a main-loop turn ends while you are away: `Finished · your turn`. No reminder for that one. |

A missing file, one that cannot be read, or one that is not a JSON object:
every default. A key with the wrong type or out of range (above 0, at most a
day): that key's default. The file is read at each notification and at each
turn end, so a change applies without a restart.

With `notify_on_stop` on, a turn you interrupted and a subagent's turn still
stay silent.

## macOS only

The hook runs `uname` (no arguments) first. Anything but `Darwin`, and nothing
else runs, nothing is sent, and nothing errors. The answer is kept for the
session.

If nothing appears, run `osascript -e 'display notification "test"'` once in
Terminal, then open System Settings → Notifications, find Script Editor, and
allow notifications. Script Editor is what `osascript` notifies through.

Running wait-ping as well? A permission prompt would then notify twice. Its
notification does not check whether you are at the terminal.

## What it does not do

- **No network, no sound, no shell.** The only programs it runs are `uname`,
  `ioreg -c IOHIDSystem` and `osascript`, each by argv.
- **It never blocks, delays or rewrites** a tool call, a prompt or a turn. It
  watches tool calls only to know when one starts and ends.
- **No notification while you are at the terminal**, and no reminder after a
  notification it did not send.
- **Nothing on Linux or Windows.**

## Developing

```
claude plugin validate ./wait-notify
claude plugin test     ./wait-notify   # 42 tests
```

`hooks/notify.ts` has no engine dependency: the copy, the config, parsing
`uname` / `ioreg` / `osascript` output, the argv, and the notifier that holds
one wait at a time. Every command, the reminder's timer and the config file
reach it through a host, so `tests/notify.test.ts` drives it directly with a
fake one. `hooks/register.ts` builds that host from `$` and wires it to the
events. `tests/flow.test.ts` drives the whole loop through the engine, with
`process.run`, `fs.read`, `HOME` and the clock answered by the test, so the
suite never posts a real notification.
