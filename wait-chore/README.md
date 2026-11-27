# wait-chore

The oldest TODO or FIXME in your repo, every time you wait on Claude. If a local branch is already merged into the default branch, its name shows too, and a delete command is suggested after the turn. This mod never runs that command, and it never edits the repo.

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install wait-chore@waitroom
```

Needs Claude Code 2.1.319 or later, and a git repository. Restart after installing. Outside a git repository, a turn stays quiet.

## What you see

While Claude works, the status line shows the text of the oldest TODO or FIXME. Claude Code adds the ⚠ and the mod's name in front.

```text
⚠ wait-chore: fix the flaky test
```

If a local branch is already merged, its name is on that line too (`fix the flaky test · leftover`). With no TODO, the line is just the branch name.

When the turn ends, the status line clears. One log line names the file, the line, and how old the comment is. If a merged branch was shown, a second line suggests the delete. Claude never sees these lines.

```text
src/auth.test.ts:12 · 3 years old
git branch -d leftover
```

The oldest comment is the one whose `git blame` date is earliest. A tie goes by path, then line number. Only tracked files are searched, and only the words `TODO` and `FIXME`.

## Commands

| Command | What it does |
| --- | --- |
| `/chore seen` | You have dealt with this TODO. It will not be shown again |
| `/chore skip` | Not this one right now. Another TODO shows first |

The commands apply to the TODO whose file and age were logged when the last turn ended, not to the merged-branch suggestion. With nothing logged yet, they say so and write nothing. `/chore seen` keeps that item out. `/chore skip` keeps it out while any other unseen TODO remains; when only skipped items are left, a skipped one can show again.

The item is the file, the line, and the text. Editing the comment makes it a new item. There are no single-key shortcuts.

## Dead branches

The default branch is read from `origin/HEAD`. It is never assumed to be `master` or `main`. If `origin/HEAD` is not set, no dead-branch card is shown. You can set it with `git remote set-head origin -a`.

Only local branches that `git branch --merged` reports as merged into that default branch are considered. The default branch itself is not suggested, and neither is the branch you are on. If more than one remains, the first in alphabetical order is shown.

The suggested command is always `git branch -d <name>`, never `-D`. This mod does not run it.

Squash-merged branches are not supported for now. A branch whose unique commits were squash-merged into the default branch is usually not listed by `--merged`, so it will not be suggested.

## Where it is kept

Seen and skipped items are kept in this plugin's store. Claude keeps that under its configuration directory. This mod does not choose the file name, and it does not write into your repository.

## Limits

It sees what git sees, from the project directory.

- `git grep` for `TODO` and `FIXME` in tracked files.
- `git blame --line-porcelain` for the date of each hit.
- `git symbolic-ref refs/remotes/origin/HEAD` for the default branch.
- `git branch --merged <that ref>` for local branches already merged into it.

Each git call gives up after 3 seconds and counts as a failed read. A failed, slow, or cut-off read leaves that part quiet: a failed grep shows no TODO, and a missing `origin/HEAD` shows no dead-branch card. A comment whose blame cannot be read is skipped, and the next oldest still shows.

A subagent's turn does not count and does not clear the line.

## What it does not do

- It never deletes a branch, never edits a file, and never commits.
- It makes no network call and sends no telemetry.
- It does not read the transcript or call a model.
- It does not take the bet's row.

## Developing

```sh
claude plugin validate ./wait-chore
claude plugin test     ./wait-chore   # 43 tests
```

`hooks/chore.ts` is the selection, the seen and skip records, and the status and log lines, with no engine. `hooks/register.ts` is the hooks. `tests/flow.test.ts` is the engine run, with git answered by the test. `tests/real-git.mjs` uses real git in a temporary repository (`node wait-chore/tests/real-git.mjs`). `tests/load-shape.test.ts` checks that `$` is only passed to a top-level helper, which is the rule that kept a hooks module from loading on Claude Code 2.1.318.
