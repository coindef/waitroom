# bet-on-your-agent (OpenCode prototype)

An unpublished, uncommitted prototype of
[`bet-on-your-agent`](../bet-on-your-agent) for
[OpenCode](https://opencode.ai). It is not a plugin you can install — see
"Status" below.

## Can a plugin capture a keypress mid-turn?

This is the question the whole prototype turns on: can an OpenCode plugin
collect a keypress or a forecast while a turn is running, the way the Claude
Code mod's row above the prompt does?

**Yes — but only from a `tui` plugin, and not through `client.tui.showToast`
or anything else a `server` plugin can call.**

OpenCode plugins come in two kinds, picked by which key a plugin module
exports (confirmed in `@opencode-ai/plugin@1.19.3`'s own type declarations,
the latest version published to npm as of this writing):

- **`server: Plugin`** — `(input, options) => Promise<Hooks>`. Runs in
  OpenCode's core/headless process. Its hooks (`tool.execute.before/after`,
  `chat.message`, `permission.ask`, …) are real and useful, but its *only*
  channel toward the terminal is `input.client`, the SDK's `OpencodeClient`.
  Every `client.tui.*` method on it — `showToast`, `appendPrompt`,
  `submitPrompt`, `clearPrompt`, `executeCommand`, `publish` — is confirmed
  one-way: each returns `Promise<boolean>` (did the call succeed), never a
  reply. `showToast` specifically takes `{title?, message, variant,
  duration?}` and shows a toast; nothing comes back from it. A `server`
  plugin, by itself, cannot read a keypress.
- **`tui: TuiPlugin`** — `(api, options, meta) => Promise<void>`. Runs inside
  the terminal renderer process itself, and `api` is a different animal:
  - `api.keymap` is a real `Keymap<Renderable, KeyEvent>` from
    `@opentui/keymap`. This was not taken on faith from the type's name —
    `@opentui/keymap@0.6.6` was installed directly and its own shipped
    `keymap.d.ts` was read: `registerLayer(layer: Layer): () => void` is a
    real, public method, where a `Layer` carries `bindings: [{key, cmd}]` and
    `commands: [{name, run(ctx)}]`. Binding `"1"`–`"5"` and `"0"` to a
    `run` callback is exactly what this prototype's band does.
  - `api.slots.register({slots: {sidebar_content: ..., session_prompt_right:
    ...}})` draws real JSX (`@opentui/solid`: `box`, `text`, `diff`, …) into
    named regions of the host UI — the equivalent surface to Claude Code's
    `ui.render` for `Pane` / `AbovePrompt`.
  - `api.event.on('session.status' | 'session.idle' | 'message.part.updated',
    …)` and `api.state.session.status(id)` give turn-running and
    file-touched signals — OpenCode's equivalent of Claude Code's
    `turn.start` / `turn.complete` / `tool.call`.

So the mechanism the open question asked about by name — `showToast` — is
exactly the one that *cannot* do this; the "another UI primitive" that can is
`api.keymap.registerLayer` plus `api.slots.register`, and only inside a `tui`
plugin.

### A documentation discrepancy, flagged rather than silently resolved

`opencode.ai/v2/docs/build/plugins/cli` describes a different, more
ergonomic-looking shape: `export default Plugin.define({id, setup(context) {
context.ui.toast.show(...); context.keymap.layer(...); context.ui.slot(...)
} })`. That shape does **not** exist anywhere in the installed
`@opencode-ai/plugin@1.19.3` — confirmed by grepping its entire `dist/`
for `keymap`, `toast`, `dialog`, and `slot`: the only matches are the raw
`./tui` entry point this prototype uses. The package's own `v2/promise` and
`v2/effect` exports (a different "v2") cover agent/catalog/command/
integration/reference/skill registration, not UI at all. Since 1.19.3 is also
the latest version on npm (checked via `npm view @opencode-ai/plugin
versions`), this is a real gap between the docs site and the shipped
package, not a version this prototype failed to catch up to. Flagging this
for human review rather than guessing which side is "right": build against
the installed types (what this prototype does), or wait for the published
package to catch up to the docs.

## What this needs that `bet-on-your-agent` does not

- **The "ask".** Claude Code's `turn.start` event carries the prompt text
  directly (`e.text`). OpenCode doesn't attach it to the busy-status event;
  it has to be fetched separately — the latest `role: "user"` message off
  `api.state.session.messages(sessionID)`, then its text parts off
  `api.state.part(message.id)`. `plugin/track.ts#askFrom` does the flattening;
  fetching the two pieces and combining them is in `plugin/tui.tsx`.
- **"How many files?"** Claude Code watches `tool.call` for `Edit`, `Write`,
  `NotebookEdit`. OpenCode's file-touching tools are named differently —
  confirmed two ways: `opencode.ai/docs/tools`' own hook example checks
  `input.tool === "apply_patch"`, implying bare names (`"edit"`, `"write"`,
  `"apply_patch"`), and `strings`-ing the actual shipped `opencode` binary
  turned up its internal registry keys `tool/edit`, `tool/write`,
  `tool/bash`, `tool/read`, `tool/glob`, `tool/grep`, `tool/webfetch`,
  `tool/websearch`, `tool/todowrite`, `tool/question`, `tool/skill` (no
  `tool/apply_patch` turned up by that search — it may be registered through
  a different, non-literal path). `plugin/track.ts#filePathOf` treats
  `"edit"` and `"write"` as file-touching and reads `input.filePath`, a field
  name inferred from the same docs page's contrast with `apply_patch`'s
  `patchText` ("`apply_patch` uses `output.args.patchText` instead of
  `output.args.filePath`") — reasonably well evidenced, but not independently
  confirmed against `edit`/`write`'s own schema.
- **A `turnId`.** OpenCode doesn't hand out one. The latest user message's id
  is used instead, on first sight of a busy status.

## What's ported

- The confidence band (1: 50% … 5: 95%, 0: skip) and the file-count band (1:
  0, 2: 1, 3: 2-3, 4: 4+), as real digit hotkeys through
  `api.keymap.registerLayer`, rendered in a `session_prompt_right` slot.
- The rotating bonus question — duration, files (again, as a three-way
  bucket), or tool calls, one dimension per turn, same buckets and wording as
  the Claude Code mod. Tool calls are counted the same unfiltered way the mod's
  `tool.call` hook does: every completed tool part, not only the file-touching
  ones `track.ts#filePathOf` already watched for (see `tui.tsx`'s
  `message.part.updated` handler and `track.ts#isNewCompletion`).
- Calibration ranks: `rankOf`, `currentRank` and the Brier cutoffs are
  imported unmodified, so `/bet`'s report already names the rank for free. The
  rank-up moment itself — "Rank up: Silver → Gold" — is tracked per session
  (`lastVerdict`, a plain `Map`, the same pattern `open`/`tracking` already
  use here) and shown once beside the post-turn "Recorded: ..." line, mirroring
  the Claude Code mod's band.
- The post-turn verdict (landed / needed fixing / skip), same mechanism.
- Scoring: `bet-on-your-agent/hooks/bet.ts` imported unmodified — `report`,
  `calibration`, `worstCalls`, `asText`, `rankOf`, `currentRank`, all of it.
- History persistence through `api.kv`, keyed the same way
  `bet-on-your-agent`'s `$.store` is (see "inferred, not confirmed" below).

Not ported this round, by design: `/bet-recap` and the badge wall. Both are
Claude Code-only features for now; a later pass can bring them here.

## Blocked on the API, not merely skipped

- **A verified, non-deprecated slash command for `/bet`.** `api.command` is
  typed and present in `@opencode-ai/plugin/tui`, and this prototype uses it,
  but the type itself says `@deprecated — kept so v1 plugins can initialize.
  Remove in v2`. No non-deprecated surface with the same shape (register a
  named, slash-invokable action) was found in the installed package. This is
  best-effort against a surface the types themselves say may be removed, not
  a confirmed-stable feature.
- **Counting files an `apply_patch` call touched.** Its tool input carries
  patch text covering possibly several files, not a single `filePath`; this
  prototype does not parse the patch to extract them (see `track.ts`).

## Inferred, not empirically confirmed — flagged for human review

- **Whether `api.kv` persists across OpenCode process restarts**, the way
  `$.store` does for the Claude Code mod (its README: "History is kept in
  the plugin's own store... survives across sessions"). `TuiKV`'s `ready`
  flag implies an async, presumably disk-backed hydration, which is why `kv`
  rather than an in-memory map was chosen for turn history here — but this
  was never run against an actual restart.
- **`session_prompt_right` is a guess at "the row above the prompt."** It is
  the slot keyed by `session_id` sitting next to `session_prompt` in
  `TuiHostSlotMap`, which is a reasonable read of the type, not a layout
  visually confirmed in a running terminal.

## How this was verified

- **Type-checked, not run**, for the same reason as the wait-review
  prototype: no configured model provider here to drive a real OpenCode
  turn, and no official test harness for a `tui` plugin. `plugin/tui.tsx`
  type-checks clean with `tsc --noEmit` against the real, freshly-installed
  `@opencode-ai/plugin`, `@opentui/core`, `@opentui/keymap`, and
  `@opentui/solid`.
- **`plugin/track.ts` is actually run and tested** — zero OpenCode types, by
  the same design as `bet-on-your-agent/hooks/bet.ts`:

  ```
  node --experimental-strip-types --test bet-on-your-agent-opencode/tests/track.test.ts
  ```

  11 tests, all passing: busy detection, which tools count as file-touching
  and which don't (including the deliberate `apply_patch` exclusion),
  flattening a user message's text parts, and which tool-part updates count
  toward the bonus question's tool-call tally (the first `'completed'` sight
  of a part, deduped against a re-fired one).
- The bonus-bet dimensions, buckets, and rank thresholds `tui.tsx` wires in
  are `bet-on-your-agent/hooks/bet.ts`'s own exports, already covered by that
  package's own test suite — nothing here reimplements them.

## Status

This is a prototype, not an installable plugin: no version, not published,
not registered anywhere. To type-check it yourself, install
`@opencode-ai/plugin`, `@opentui/core`, `@opentui/keymap`, and
`@opentui/solid` next to a copy of this folder plus
`../bet-on-your-agent/hooks` and `../bet-on-your-agent/types` (it imports both
by relative path), then run `tsc --noEmit`.
