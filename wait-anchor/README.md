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

While a note is set, this mod's status line keeps the check words you wrote:

```text
⚓ ship login fix → redirect works
```

The goal, an arrow, and the check. The check is not rewritten into a shorter label. Past 48 columns the line ends in `…`, on a character boundary. The stored check stays whole.

Claude Code draws one status line per mod and chooses the order. This mod does not ask to sit under the bet. It does not draw in the row above the prompt, so the bet's question and its keys stay as they are. It does not open a pane or a toast. With no note, it sets no line. The host puts its own mark and this mod's name in front of the sentence.

## When you come back

Stop a turn, or let it finish. The note stays. The next prompt you type logs one line:

```text
Back? You said: redirect works.
```

The prompt itself is unchanged. The line is `$.ui.log`. Claude Code does not send that log to the model. A second prompt does not log it again. The next Stop arms it once more. A subagent's turn does not.

## Where it is kept

The note is one JSON value in `$.store`. That store is this plugin's. Claude keeps it under its configuration directory. This mod does not choose the file name.

The key comes from the project root and the session id the host reports. The value is the goal, the check, and whether the return line is still owed.

Every session of this plugin on the machine shares that store. The key is what keeps two sessions apart, including two directories with the same name. A missing session id or a missing project root does not pick a shorter key. Nothing is saved, and the reply says so. The process id and the folder name are not keys.

Stop does not clear the note. `/anchor clear` does. What a new process still sees is whatever `$.store` still holds. This mod does not keep a second copy.

The text is stored as text. Control characters and color codes are stripped before it is stored. It is not an instruction.

## What it does not do

- It does not ask you to set a note each turn.
- It does not summarize the session.
- It does not read the transcript, call a model, or open a connection.
- It does not take the bet's row.

## Developing

```sh
claude plugin validate ./wait-anchor
claude plugin test     ./wait-anchor   # 33 tests
```

`hooks/anchor.ts` has the note, the command, the 48-column line, and the store key, with no engine. `hooks/register.ts` is the hooks. `tests/flow.test.ts` is the engine run. `tests/wiring.test.ts` drives `register` through a stand-in for `$`. That file is not a Claude Code session, and a pass there does not mean the hooks module loaded. `demo/leave-and-return.ts` is the same stand-in across processes. `tests/load-shape.test.ts` checks that `$` is only passed to a top-level helper, which is the rule that kept the module from loading on Claude Code 2.1.318.
