# wait-review (OpenCode prototype)

An unpublished, uncommitted prototype of wait-review for
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
  `session.idle` event, which plays `turn.complete`'s. The pre-existing
  hunk snapshot is taken when the plugin loads, before a turn writes, instead
  of on the first `busy` (that race filed the turn's own hunks as
  pre-existing). See `createReview` in `plugin/review.ts`.
- **Telling a subagent's turn from the main one.** Claude Code's events carry
  `agentId`. OpenCode's subagents are separate child sessions
  (`client.session.children`), so this adapter only reacts to `session.idle`
  for session ids it has itself begun tracking — a subagent's session id is
  never one of those, since nothing here opens its route.

Everything else — hunk parsing, the ignore list, merge-and-reorder logic,
progress and summary text — is `src/vendor/wait-review/hooks/diff.ts`,
vendored unmodified from the removed Claude Code mod. That is the actual
finding of this prototype: the portable core really is portable.

## What's ported

- The scan, the queue, and `o` / `f` / `l` / `x` / `u` as real keymap hotkeys
  bound through `api.keymap.registerLayer` (confirmed against
  `@opentui/keymap`'s real `Keymap.registerLayer`, not guessed from a type
  name). The layer's `enabled` gate is on only while the pane is showing a
  hunk, and each command returns not-handled when it changes nothing (`u`
  only when a decision can be undone), so those keys still reach the prompt
  otherwise. OpenCode installs that gate via `registerEnabledFields` in
  `createDefaultOpenTuiKeymap`.
- A `sidebar_content` slot rendering the current hunk (path, position, a
  `<diff>` element for the hunk text, the hotkey legend, the flagged count).
  The queue lives in a Solid store, and the slot reads it, so a keypress or
  a finished scan repaints.

## What's not ported — scoped out, not blocked

- **Saying why a hunk is flagged, and attaching flagged hunks to the next
  prompt.** Both look reachable (a keymap command could call
  `api.client.session.prompt`, and OpenCode's `input` element could take the
  note) but neither is implemented here.
- **The pre-existing-work snapshot** is taken once, when the plugin loads,
  before the first turn's writes. There is still no `session.start` event;
  `busy` only means "this session should be scanned on idle". An idle that
  arrives while the snapshot's git is still running waits for it, then scans.

## How this was verified

- **Type-checked.** `plugin/tui.tsx` was checked with `tsc --noEmit` against
  the real `@opencode-ai/plugin@1.19.3`, `@opentui/core`, `@opentui/keymap`,
  and `@opentui/solid` (installed in this folder) — not against a
  hand-written approximation of their types.
- **Loaded in a real OpenCode 1.19.3 TUI.** The `opencode.json` `plugin` key
  does not load a TUI plugin. The Plugins dialog does: command palette →
  Plugins → Install plugin, then this folder's path. That writes
  `.opencode/tui.json`. With the sidebar open and the pane reading
  `wait-review: nothing to read`, `u` `o` `f` `l` `x` landed in the prompt.
  After a later turn, with `new.ts` on screen, `o` advanced the pane to the
  next file and `u` restored it, both without reaching the prompt. `f`
  flagged and moved on, `l` stayed on that later hunk, and `x` replaced the
  card with the summary; none of those three reached the prompt. Before any
  decision, `u` still reached the prompt. No provider login and no API key:
  the session used OpenCode's built-in Big Pickle model. See the tests below
  for the same rules without a TUI.
- **`plugin/scan.ts` is actually run and tested.** It has zero OpenCode
  types, by the same design as `wait-review/hooks/diff.ts`, so it runs under
  Node directly:

  ```
  node --conditions=browser --experimental-strip-types --test wait-review-opencode/tests/scan.test.ts wait-review-opencode/tests/review.test.ts
  ```

  `--conditions=browser` matters for the review tests: it loads solid-js's
  client build. Node would otherwise load the server build, which does not
  track reads, and OpenCode's own solid plugin swaps that server file for
  the client one.

  Install this folder's dev dependencies first (`npm install` here). The
  scan tests cover the anchor-fallback chain and the ignored-before-the-cap
  untracked-file logic. The review tests cover keys passing through when no
  hunk is on screen, the pane repainting off a Solid store, and a real-git
  first turn that is shown instead of filed as pre-existing.

## Status

This is a prototype: no version, not published, not registered anywhere.
It can still be loaded locally from the Plugins dialog (Install plugin,
then this folder's path), which is how the live check above was done. The
shared diff/types modules live under
`src/vendor/wait-review/` (copied from the removed `wait-review` package).
To type-check it yourself, install `@opencode-ai/plugin`, `@opentui/core`,
`@opentui/keymap`, and `@opentui/solid` in this folder, then run
`npx -y -p typescript@5.7 tsc -p .`.
