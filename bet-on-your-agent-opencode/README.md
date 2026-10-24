# bet-on-your-agent (OpenCode prototype)

An unpublished prototype of [`bet-on-your-agent`](../bet-on-your-agent) for
[OpenCode](https://opencode.ai). It is not registered in any marketplace or
npm registry, but it can be, and has been, loaded into a real local OpenCode
TUI session for verification — see "Status" below.

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
`@opencode-ai/plugin@1.19.3`, confirmed two ways, not just by grepping for
identifier names:

1. There is no runtime `Plugin` value anywhere in the package to call
   `.define` on. `dist/index.js` (the bare `@opencode-ai/plugin` entry) is
   just `export * from "./tool.js"` — `Plugin` only exists as a type alias
   there (`export type Plugin = (input, options) => Promise<Hooks>`), for a
   `server` plugin module, not a callable namespace.
2. `dist/v2/promise/index.js` (and the mirror `v2/effect` build) *does* export
   a bare `define(plugin)` function with roughly the docs' shape —
   `{id, setup(context)}` — but `define` is a plain named export, never
   `Plugin.define`, and its `PluginContext` (`dist/v2/promise/context.d.ts`)
   has fields for `agent`, `aisdk`, `catalog`, `command`, `integration`,
   `plugin`, `reference`, `skill` — registration surfaces, not one `ui`,
   `keymap`, `toast`, or `slot` among them. So even reconciling the `.define`
   naming, the `context.ui.toast.show(...)` /
   `context.keymap.layer(...)` / `context.ui.slot(...)` calls the docs show
   have nothing to call them on in this version.

Since 1.19.3 is also the latest version on npm (checked via `npm view
@opencode-ai/plugin versions`), this is a real gap between the docs site and
the shipped package, not a version this prototype failed to catch up to.
Flagging this for human review rather than guessing which side is "right":
build against the installed types and the raw `./tui` entry point (what this
prototype does), or wait for the published package to catch up to the docs.
**Do not "fix" `plugin/tui.tsx` toward the docs' `Plugin.define` shape** —
it would fail to import in this package version; the `TuiPlugin`/
`TuiPluginModule` default export this prototype uses is the only UI-capable
surface that actually exists.

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
- History persistence through `api.kv`, keyed by `track.ts`'s `TURNS_KV_KEY`
  rather than a bare word (see "Confirmed by tracing the shipped binary"
  below for why).

Not ported this round, by design: `/bet-recap` and the badge wall. Both are
Claude Code-only features for now; a later pass can bring them here.

## Blocked on the API, not merely skipped

- **A verified, non-deprecated slash command for `/bet`.** `api.command` is
  typed and present in `@opencode-ai/plugin/tui`, and this prototype uses it,
  but the type itself says: "Legacy `api.command` API kept so v1 plugins can
  initialize. Remove in v2. @deprecated Use `api.keymap.registerLayer`,
  `api.keymap.dispatchCommand`, and
  `api.keymap.dispatchCommand("command.palette.show")` instead." That
  replacement covers binding and invoking commands, not naming a *new* one
  slash-invokable: `@opentui/keymap`'s own `Command` type is just `{name,
  run, [key: string]: unknown}`, with no `slash`/`slashName` semantics
  recognized anywhere in its own matching logic. The shipped `opencode`
  binary's built-in commands (`/sessions`, `/new`, …) do carry
  `slashName`/`slashAliases` fields — confirmed by grepping the compiled
  binary's own source — but that is an internal convention its own command
  palette reads, not exported or typed anywhere a plugin could rely on it.
  So this stays on `api.command`: best-effort against a surface the types
  say may disappear, rather than against an unexported convention just as
  likely to move without notice.
- **Counting files an `apply_patch` call touched.** Its tool input carries
  patch text covering possibly several files, not a single `filePath`; this
  prototype does not parse the patch to extract them (see `track.ts`).

## Confirmed by tracing the shipped binary, then by running it for real

Both items below started as open questions settled only by `strings`-ing the
shipped `opencode` binary and reading its own — minified but otherwise
intact — source. Both have since also been confirmed against a real,
running OpenCode TUI (see "How this was verified" below for the method); the
binary-tracing conclusions held, and the second item surfaced a real bug
that is now fixed.

- **`api.kv` does persist across OpenCode process restarts.** Its KV
  provider's `init()` reads, and its `set()` writes (both under a file
  lock), `path.join(<tui state dir>, "kv.json")` — a real file on disk, not
  an in-memory map — which is why the type's `ready` flag exists (it flips
  once the on-disk read resolves). This is read the way `$.store` is for the
  Claude Code mod: it survives a restart. Confirmed with an actual
  two-process restart, not just the binary trace: one OpenCode process set a
  sentinel value under `TURNS_KV_KEY` and exited; a second, fresh process
  read the identical value back, and `kv.json` on disk held
  `{"bet-on-your-agent:turns": <the sentinel>}` the whole time.

  It is, however, **one flat store shared by every installed TUI plugin**,
  not namespaced per plugin. The per-plugin api object the host builds for
  each loaded plugin wraps `slots.register` with an id-prefixed key, but
  forwards `kv` straight through unwrapped from the single app-wide api
  object built once at startup — confirmed by reading that wiring function
  in the compiled bundle directly. A bare key like `"turns"` could therefore
  collide with some other plugin's own key of the same name. Fixed here:
  `track.ts`'s `TURNS_KV_KEY` namespaces the key to this plugin's id instead
  of a generic word, and is covered by its own test.
- **`session_prompt_right` does land where "the row above the prompt"
  intends, and shares its row with the host's own status text.** This is
  not merely "the slot keyed by `session_id` sitting next to
  `session_prompt` in `TuiHostSlotMap`'s declaration order" — the host's own
  Prompt component threads this slot's content through a dedicated `right:
  JSX.Element` prop and renders it as a `flexDirection: row` box inside the
  prompt's own chrome, alongside the prompt's other decorations — including
  the host's own "Build · \<model\> OpenCode" status indicator, which lives
  in that same row. A live 60/70/80-column terminal showed that, without a
  width cap, the two boxes fight over the row's width and *both* wrap — not
  just this slot's text but the host's own status text too, split one
  character per line and interleaved with this slot's content, unreadable at
  every width tested. The fix, applied to every branch of this slot:
  `wrapMode="none"` on every `<text>` here, plus `maxWidth="50%"` on every
  outer `<box>` (and the one branch that is a bare `<text>`). That reserves
  at most half the row for this slot and leaves the other half to the host,
  so the host's status text now always renders intact and this slot's own
  content truncates cleanly at its 50% boundary instead of interleaving.
  There is no narrower API to size this against the real column count
  instead of a fixed fraction: the `ctx` a slot callback receives
  (`TuiSlotContext`) exposes only `theme`, nothing about width.

## How this was verified

- **A real two-process `api.kv` restart**, not a unit test or a source
  reading: a small throwaway TUI plugin package (sharing `track.ts`'s own
  `TURNS_KV_KEY` constant by importing it directly) called `api.kv.set` on
  load, then exited; a second, fresh OpenCode process with a second
  throwaway plugin called `api.kv.get` on load and read the same value back.
  Both ran as real plugins inside a real, pty-driven OpenCode 1.19.3 TUI
  session (`opencode-darwin-arm64`, installed locally for this check, not
  the npm types package), loaded through the same `api.kv`/`TURNS_KV_KEY`
  path `plugin/tui.tsx` itself uses, not a reimplementation of it.
- **A real, live OpenCode TUI session with this adapter installed and
  active**, using the real, unmodified `bet-on-your-agent-opencode` package
  (installed via the TUI's own "Install plugin" dialog, which reads this
  package's `package.json` `exports` map the same way a real user's install
  would). Since this environment has no configured model provider, the
  `session_prompt_right` slot's "owed verdict" branch was exercised by
  seeding one unresolved `TurnRecord` under `TURNS_KV_KEY` (the same key,
  shape, and `api.kv` path `plugin/tui.tsx#loadTurns`/`saveTurns` use) and
  then viewing an existing session — `owedVerdict` finds the seeded record
  and renders the slot without needing a live turn or any network call. The
  terminal was driven at 60, 70, and 80 columns this way; see the
  `maxWidth`/`wrapMode` fix above for what that showed and how it was
  addressed. The other branches of this slot (the confidence/files/bonus
  bands, which only open while a turn is actually running) share the exact
  same `wrapMode`/`maxWidth` fix but were not directly observed this way,
  since reaching them would require a real chat turn against a real model.
- **Type-checked**, in addition to the above: `plugin/tui.tsx` type-checks
  clean with `tsc --noEmit` against the real, freshly-installed
  `@opencode-ai/plugin`, `@opentui/core`, `@opentui/keymap`, and
  `@opentui/solid`.
- **`plugin/track.ts` is actually run and tested** — zero OpenCode types, by
  the same design as `bet-on-your-agent/hooks/bet.ts`:

  ```
  node --experimental-strip-types --test bet-on-your-agent-opencode/tests/track.test.ts
  ```

  12 tests, all passing: busy detection, which tools count as file-touching
  and which don't (including the deliberate `apply_patch` exclusion),
  flattening a user message's text parts, which tool-part updates count
  toward the bonus question's tool-call tally (the first `'completed'` sight
  of a part, deduped against a re-fired one), and the `TURNS_KV_KEY`
  namespacing fix above.
- The bonus-bet dimensions, buckets, and rank thresholds `tui.tsx` wires in
  are `bet-on-your-agent/hooks/bet.ts`'s own exports, already covered by that
  package's own test suite — nothing here reimplements them.
- The documentation-discrepancy section above (the `Plugin.define` shape)
  was settled by extracting readable, minified-but-intact JS source strings
  out of the installed `opencode-darwin-arm64` binary (`strings` on the
  Bun-compiled executable) and reading the relevant implementation directly.

## Status

An unpublished prototype: no version bump, not published to npm, not
registered in any marketplace. It can be loaded into a real OpenCode
session locally, though, the same way any local package can: open the
Plugins dialog (command palette → "Plugins" → "Install plugin"), enter this
folder's absolute path, and OpenCode reads its `package.json` `exports` map
to find the `./tui` entry point. That is how it was loaded for the real
2026-10-24 verification pass described above. To just type-check it
yourself without running it, install `@opencode-ai/plugin`, `@opentui/core`,
`@opentui/keymap`, and `@opentui/solid` next to a copy of this folder plus
`../bet-on-your-agent/hooks` and `../bet-on-your-agent/types` (it imports
both by relative path), then run `tsc --noEmit`.
