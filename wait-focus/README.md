# wait-focus

Name up to three paths. After the turn, each one says whether it got touched.

A file or a folder. You point. This mod reports. It never blocks an edit.

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install wait-focus@waitroom
```

Needs Claude Code 2.1.318 or later. Restart after installing.

## Commands

| Command | What it does |
| --- | --- |
| `/wait-focus src/auth/ package.json` | Watches those paths. One, two, or three. Replaces the list you had |
| `/wait-focus` | Shows the list. With none, prints `/wait-focus src/auth/ or package.json · up to 3` |
| `/wait-focus clear` | Clears it. The status line goes with it |

The command is `/wait-focus`. `/focus` is already a Claude Code command.

The reply is the command's own text. It does not start a turn. A fourth path is refused, and the list you already had stays. A path outside the project is refused the same way. So is a glob (`src/**/*.ts`, `src/auth/*`): name a file or a folder.

`/wait-focus clear` is the clear command only when `clear` is the whole line.

## What you see

After a main-loop turn, this mod's status line names every path you watched:

```text
src/auth/ touched · package.json untouched
```

Claude Code puts its own mark and this mod's name in front of that sentence. A folder is touched when anything under it changed. That includes a new file, a rename, and a delete. A file is touched when that file changed, not when some other file did.

A path that is not on disk yet is still watched. It reads untouched until a turn creates it. The reply says `(not on disk yet)` so you can see that when you set it.

The line comes down while the next turn runs, then the new verdict replaces it. Past 48 columns, folders are shortened from the left (`…/LoginForm.tsx touched`) so every `touched` or `untouched` stays. With no paths, it sets no line.

This mod does not draw in the row above the prompt, so the bet's question and its keys stay as they are. It does not open a pane.

## Where it is kept

The list is one JSON value in this plugin's store. Claude keeps it under its configuration directory. This mod does not choose the file name.

The key is the project root. Two sessions in one project share the list. Two projects do not, including two directories with the same name. A missing project root saves nothing, and the reply says so.

`/wait-focus clear` removes that one key. A new process sees whatever the store still holds.

## Limits

It sees what git sees, from the project directory.

- `git diff --name-status -M --relative` for tracked changes, renames, and deletes.
- `git ls-files --others` for untracked files.
- `git hash-object` for the contents, so a file that was already dirty still counts when this turn changes it.

A file git ignores is not counted. Outside a git repository, the list can still be saved, and the reply says a turn here stays quiet.

Each git call gives up after 3 seconds. A failed call, a timeout, or output that was cut off draws no line. The turn is not failed and not slowed past that cap. The same thing happens when more than 40 changed files sit under your paths: no guess, no line.

A subagent's turn does not count and does not clear the line.

## What it does not do

- It never blocks a tool, never edits a file, and never commits.
- It makes no network call and sends no telemetry.
- It does not read the transcript or call a model.
- It does not take the bet's row.

## Developing

```sh
claude plugin validate ./wait-focus
claude plugin test     ./wait-focus   # 34 tests
```

`hooks/focus.ts` is the list, the path checks, and the touched or untouched line, with no engine. `hooks/register.ts` is the hooks. `tests/flow.test.ts` is the engine run, with git answered by the test. `tests/load-shape.test.ts` checks that `$` is only passed to a top-level helper, which is the rule that kept a hooks module from loading on Claude Code 2.1.318.
