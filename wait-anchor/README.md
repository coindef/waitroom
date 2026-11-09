# wait-anchor

Leave a note for future you.

A goal, and what to check when you come back. You set it. Nothing here writes a summary, reads the transcript, or calls a model.

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install wait-anchor@waitroom
```

Needs Claude Code 2.1.318 or later. Restart after installing.

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

The prompt itself is unchanged. The `Back?` line is shown to you, not sent to the model. If saving the note fails, the line is skipped and shows on your next prompt instead. A second prompt does not log it again until another main-loop turn ends. A subagent's turn does not count.

A real Claude Code session has shown the `Back?` line after a turn that finished. It has not been checked in a real session after a turn you interrupt. The engine flow tests run an aborted turn, but a test does not replace that check.

## Where it is kept

The note is one JSON value in this plugin's store. Claude keeps it under its configuration directory. This mod does not choose the file name.

The key comes from the project root and the session id the host reports. The value is the goal, the check, and whether the return line is still owed.

Every session of this plugin on the machine shares that store. The key is what keeps two sessions apart, including two directories with the same name. A missing session id or a missing project root does not pick a shorter key. Nothing is saved, and the reply says so. The process id and the folder name are not keys.

A set or delete replaces one key. It does not read every note and write them back. Two different session ids are separate keys, whether or not they share a project directory. Two directories with the same name are also separate keys, because the project root differs. Two Claude Code processes on the same session id may overwrite each other's note.

Stop does not clear the note. `/anchor clear` does. A new process sees whatever the store still holds. This mod does not keep a second copy.

The text is stored as text. Control characters and color codes are stripped before it is stored. It is not an instruction.

## What it does not do

- It does not ask you to set a note each turn.
- It does not summarize the session.
- **No transcript reads.** The note never comes from your transcript. The `Back?` line is shown to you, not sent to the model.
- If the note can't be saved, the `Back?` line waits for your next prompt.
- It does not call a model or open a connection.
- It does not take the bet's row.

## Developing

```sh
claude plugin validate ./wait-anchor
claude plugin test     ./wait-anchor   # 34 tests
```

`hooks/anchor.ts` has the note, the command, the 48-column line, and the store key, with no engine. `hooks/register.ts` is the hooks. `hooks/store-barrier.ts` is the test-only store rendezvous used by `demo/real-store-race.sh`. `tests/flow.test.ts` is the engine run. `tests/wiring.test.ts` drives `register` through a stand-in for `$`. That file is not a Claude Code session, and a pass there does not mean the hooks module loaded. `demo/leave-and-return.ts` is the same stand-in across processes. `tests/load-shape.test.ts` checks that `$` is only passed to a top-level helper, which is the rule that kept the module from loading on Claude Code 2.1.318.

`claude plugin test` runs 34 tests:

- 17 pure tests
- 9 wiring tests against the stand-in for `$`. Those are not evidence about the real store.
- 5 engine flow tests, with the identity, the store, and the UI mocked
- 3 load-shape tests

### Real store check

```sh
bash wait-anchor/demo/real-store-race.sh
```

Exit 2 means the opening probe failed. Not being logged in is one such failure. Exit 2 is not a pass.

Exit 0 means every attempt passed fresh-process readback isolation. The script runs each of three cases many times (default 20) and prints an overlap count `k/N` per case. Overlap here means both writers stamped `start` immediately before their store call and `done` after it, with `max(start) < min(done)`. Isolation is the pass criterion. A positive `k` shows those store intervals overlapped in time; it is still not proof that two writers of one key are safe.

The rendezvous is test-only. Both `WAIT_ANCHOR_STORE_BARRIER` (a directory) and `WAIT_ANCHOR_STORE_BARRIER_OK=1` must be set, or the gate is off and notes write straight through. **Never set either in production.**

Separately from the tests, real Claude Code sessions in a terminal confirmed four things:

- Two sessions ran at the same time in two project directories with the same name. Each kept its own note. Clearing one did not change the other.
- Each session, restarted as a new process with `--resume` and the same session id, still had its note.
- After a turn that finished, the `Back?` line appeared on screen once. Running `/anchor` next did not add a second one.
- After `/anchor clear` in each session, the status line was gone and `/anchor` printed its no-note reply.

Tested on Claude Code 2.1.319. `claude plugin test` runs 34 tests.
