# wait-anchor

Leave a note for future you.

A goal, and what to check when you come back. You set it. Nothing here writes a summary, reads the transcript, or calls a model.

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install wait-anchor@waitroom
```

Needs Claude Code 2.1.291 or later. Restart after installing.

The pixel icon is not in this change.

## Commands

| Command | What it does |
| --- | --- |
| `/anchor ship login fix · check: redirect works` | Sets the note, or replaces the one already set |
| `/anchor` | Shows the note. With none, prints `/anchor what you're doing · check: what to verify` |
| `/anchor clear` | Clears it |

The reply is the command's own text. It does not start a turn.

While a note is set, this mod's status line is:

```text
⚓ ship login fix → redirect works
```

That is the sentence this mod sets: the goal, an arrow, and the check you wrote. Past 48 columns it ends in `…`, on a character boundary. The mods API keeps one status line per mod and, in its own docs, puts a warning mark and the mod's name in front of that sentence. With no note, this mod sets no line.

The line is not the row above the prompt. bet-on-your-agent keeps that row, including its keys and its question. This mod does not draw there, and it does not open a pane or a toast.

## When you come back

Stop a turn, or let it finish. The note stays. The next prompt you type logs one line:

```text
Back? You said: redirect works.
```

The prompt itself is unchanged. The line is a transcript log, which Claude Code does not send to the model. A second prompt does not log it again. The next Stop arms it once more. A subagent's turn does not.

The note is still there after a process restart, until `/anchor clear`.

## Where it is kept

One value in this mod's store, for this project root and this session id. Two sessions do not share it, including two directories with the same name. A missing session id or a missing project root saves nothing and says so. The note is not filed under the process id or the folder name.

The text is stored as text. Control characters and color codes are stripped. It is not an instruction.

## What it does not do

- It does not ask you to set a note each turn.
- It does not summarize the session.
- It does not read the transcript, call a model, or open a connection.
- It does not take the bet's row.

## Developing

```sh
claude plugin validate ./wait-anchor
claude plugin test     ./wait-anchor   # 30 tests
```

`hooks/anchor.ts` has the note, the command, the 48-column line, and the store key, with no engine. `hooks/register.ts` is the hooks. `tests/flow.test.ts` is the engine run. `demo/leave-and-return.ts` is a simulated host: separate processes, the real `register` module, a file standing in for `$.store`. It is not a Claude Code session.
