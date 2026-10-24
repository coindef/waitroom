# wait-review (OpenCode prototype)

An unpublished, uncommitted prototype of [`wait-review`](../wait-review) for
[OpenCode](https://opencode.ai). It is not a plugin you can install — see
"Status" below.

## Can an OpenCode plugin do this at all?

See the root question answered in
[`bet-on-your-agent-opencode/README.md`](../bet-on-your-agent-opencode/README.md#can-a-plugin-capture-a-keypress-mid-turn).
The short version: yes, but only from a `tui` plugin, never from a `server`
one, and never through `client.tui.showToast`.

The same README also documents a
[docs-vs-shipped-package discrepancy](../bet-on-your-agent-opencode/README.md#a-documentation-discrepancy-flagged-rather-than-silently-resolved)
around `opencode.ai`'s docs showing a `Plugin.define({id, setup(context)})`
shape that does not exist in the installed `@opencode-ai/plugin@1.19.3` —
confirmed by reading the package's actual runtime exports, not just grepping
identifier names. `plugin/tui.tsx` here uses the same real `TuiPlugin`/
`TuiPluginModule` default-export shape as that other prototype; **do not
"fix" it toward the docs' `Plugin.define` shape**, which would fail to
import in this package version.

## What this needs that `wait-review` does not

Claude Code hands a mod `$.process.run` for git and a `session.start` /
`turn.start` / `turn.complete` lifecycle. OpenCode's `tui` plugin has neither:

- **Running git.** A `tui` plugin is plain Node/Bun code with no engine
  sandbox, so it shells out directly (`node:child_process.spawn('git', …)`)
  rather than through an engine-provided runner. `plugin/scan.ts` is the exact
  same three-tier fallback (`diff <anchor>` → `diff HEAD` → bare `diff`, then
  untracked files via `--no-index`) as `wait-review/hooks/register.tsx`'s
  `scanRepo`/`repoRoot`, just with the git runner injected instead of being
  `$.process.run`.
- **Knowing a turn started or ended.** There is no `session.start` or
  `turn.complete` event. The nearest equivalents, both confirmed in
  `@opencode-ai/sdk`'s generated types: `session.status` (`{type: "idle" |
  "retry" | "busy"}`), which plays `turn.start`'s role, and the dedicated
  `session.idle` event, which plays `turn.complete`'s. A session is "begun"
  (anchored, pre-existing hunks snapshotted) the first time its status goes
  busy, instead of on a one-time `session.start` hook — see `beginSession` in
  `plugin/tui.tsx`.
- **Telling a subagent's turn from the main one.** Claude Code's events carry
  `agentId`. OpenCode's subagents are separate child sessions
  (`client.session.children`), so this adapter only reacts to `session.idle`
  for session ids it has itself begun tracking — a subagent's session id is
  never one of those, since nothing here opens its route.

Everything else — hunk parsing, the ignore list, merge-and-reorder logic,
progress and summary text — is `wait-review/hooks/diff.ts`, imported
unmodified. That is the actual finding of this prototype: the portable core
really is portable.

## What's ported

- The scan, the queue, and `o` / `f` / `l` / `x` / `u` as real keymap hotkeys
  bound through `api.keymap.registerLayer` (confirmed against
  `@opentui/keymap`'s real `Keymap.registerLayer`, not guessed from a type
  name).
- A `sidebar_content` slot rendering the current hunk (path, position, a
  `<diff>` element for the hunk text, the hotkey legend, the flagged count).

## What's not ported — scoped out, not blocked

- **Saying why a hunk is flagged, and attaching flagged hunks to the next
  prompt.** Both look reachable (a keymap command could call
  `api.client.session.prompt`, and OpenCode's `input` element could take the
  note) but neither is implemented here.
- **The pre-existing-work snapshot taken at session start** is ported
  faithfully in spirit (see `beginSession`), but "session start" itself is
  inferred from the first busy status rather than a dedicated event — see
  above.

## How this was verified

- **Type-checked**, not run. `plugin/tui.tsx` was checked with `tsc --noEmit`
  against the real `@opencode-ai/plugin@1.19.3`, `@opentui/core`,
  `@opentui/keymap`, and `@opentui/solid` (latest, installed fresh) — not
  against a hand-written approximation of their types. It has not been run
  inside a live `opencode` TUI session: that needs a configured model
  provider, which this environment does not have, and there is no official
  test harness for a `tui` plugin the way `claude plugin test` exists for a
  Claude Code mod.
- **`plugin/scan.ts` is actually run and tested.** It has zero OpenCode
  types, by the same design as `wait-review/hooks/diff.ts`, so it runs under
  Node directly:

  ```
  node --experimental-strip-types --test wait-review-opencode/tests/scan.test.ts
  ```

  9 tests, all passing, covering the anchor-fallback chain and the
  ignored-before-the-cap untracked-file logic — the same behavior
  `wait-review/tests/flow.test.ts` checks for the Claude Code mod, ported to
  an injected git runner instead of a fake engine.

## Status

This is a prototype, not an installable plugin: no version, not published,
not registered anywhere. To type-check it yourself, install
`@opencode-ai/plugin`, `@opentui/core`, `@opentui/keymap`, and
`@opentui/solid` next to a copy of this folder plus `../wait-review/hooks` and
`../wait-review/types` (it imports both by relative path), then run `tsc
--noEmit`.
