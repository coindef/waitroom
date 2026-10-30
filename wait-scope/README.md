# wait-scope

<img src="./.claude-plugin/icon.svg" width="56" align="right" alt="wait-scope's icon">

A Claude Code plugin that warns when a turn edits files outside the scope you
set. **wait-changed shows what changed this turn; wait-scope shows what changed
outside what you asked for.** Local only. It only warns.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-scope@waitroom
```

This install stays on its own. The four rooms are `/plugin install waitroom@waitroom`.

## Setting the scope

Your globs are authoritative. Two places, the first one found wins:

1. **`.claude/wait-scope`** at the project root — one glob per line, blank
   lines and `#` comments ignored:

   ```
   # this task
   src/auth/**
   tests/auth/*.test.ts
   docs
   ```

2. **Files in scope** under `/plugin` → wait-scope — comma-separated
   (`src/auth/**, docs`).

Globs are relative to the project root. `*` stays inside one folder, `**`
crosses folders, `?` is one character, and a bare folder name covers
everything inside it. An edit outside the project root is always outside.

## What it shows

- **While a turn runs.** After each landed `Edit`, `Write`, `MultiEdit` or
  `NotebookEdit`, the status line says `2 outside scope` — counting only files
  outside your globs. Nothing at 0.
- **Once the turn ends.** The row above the prompt lists those files under
  `Changed outside what you asked for` (up to eight, then `N more files…`).
  `Close` puts it away; `Don't show again` turns it off.

### No scope set

With no file and no setting, wait-scope guesses from the paths your prompt
names (`fix src/auth/login.ts`). Files the turn edited outside those are
listed at turn end marked `(guess)`. A guess never reaches the status line and
is never counted as outside scope. A prompt that names no path, with no scope
set, shows nothing at all.

## What it never does

It never blocks a tool, never reverts or edits a file, makes no network call,
and sends no telemetry. It reads your scope file and the edit tools' own
paths, and nothing else.

`/wait-scope` turns the warning off, and the next `/wait-scope` turns it back
on — the same switch as *Warn when a turn edits outside the scope* under
`/plugin` → wait-scope.

## Develop

```sh
claude plugin validate ./wait-scope
claude plugin test     ./wait-scope   # 47 tests
```
