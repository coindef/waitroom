# Contributing


Each mod is a self-contained plugin folder. From the repository root:

```
claude plugin validate ./wait-review
claude plugin test     ./wait-review          # 101 tests

claude plugin validate ./bet-on-your-agent
claude plugin test     ./bet-on-your-agent    # 130 tests

claude plugin validate ./wait-ship
claude plugin test     ./wait-ship            # 70 tests

claude plugin validate ./wait-breathe
claude plugin test     ./wait-breathe         # 28 tests

claude plugin validate ./wait-changed
claude plugin test     ./wait-changed         # 32 tests

claude plugin validate ./wait-ping
claude plugin test     ./wait-ping            # 31 tests

claude plugin validate ./wait-scope
claude plugin test     ./wait-scope           # 47 tests

claude plugin validate ./wait-secret
claude plugin test     ./wait-secret          # 21 tests

claude plugin validate ./wait-shell
claude plugin test     ./wait-shell           # 37 tests

claude plugin validate ./waitroom
claude plugin test     ./waitroom             # 6 tests
```

Neither of those runs a real type checker, so also run `tsc` from each mod's
folder once it has loaded at least once (that's what writes
`.claude-plugin/types/`, which the mod's `tsconfig.json` points at):

```
npx -y -p typescript@5.7 tsc -p .
```

(`typescript@latest` currently ships a rewritten `tsc` whose CLI rejects
`-p` outright — pin a 5.x release rather than chasing that down again.) A
clean run prints nothing. This caught a real bug once already (two call
sites where a status literal silently widened to `string` inside a `.map`,
erasing the protection `HunkStatus` was there to give) that 84 passing tests
and a clean `validate` both missed — run it after any change to any mod's
`hooks/`, not just when something looks wrong.

Run a working copy without installing it, or install from this clone so edits
reload in place:

```
claude --plugin-dir ./wait-review
# or
claude plugin marketplace add .     # then /plugin install <mod>@waitroom
```

Each mod keeps the logic that needs no engine in one plain module
(`hooks/diff.ts`, `hooks/bet.ts`, `hooks/ship.ts`, `hooks/breathe.ts`,
`hooks/changed.ts`, `hooks/ping.ts`, `hooks/secret.ts`, `hooks/shell.ts`,
`hooks/tip.ts`) so it
can be tested directly, with the hooks module beside it and a
`types/index.d.ts` state contract that `claude plugin validate` holds it to.
Each mod's own `tests/flow.test.*` or `tests/band.test.tsx` drives the real
loop through the engine, git and all.

`.claude-plugin/types/` inside a mod is written by the engine on each load and
is not checked in.

## userConfig conventions

Two option names recur across mods; a new one should follow the same meaning
rather than pick a fresh one:

- **`autoOpen`** governs whether a mod's *pane* opens by itself at session
  start — not whether the mod itself runs. Its default follows whether the
  pane is that mod's main surface or a secondary record: `true` for
  wait-review, whose pane is where it does its work; `false` for
  bet-on-your-agent, whose main surface is the row above the prompt, so the
  pane is only worth the screen space once you ask for it with `/bet`.
- **`enabled`** is a master switch, present only on mods with a core behavior
  worth turning off entirely — wait-ship, wait-breathe, wait-changed, wait-ping, and wait-scope.
  wait-review and bet-on-your-agent have no `enabled` key at all, because
  neither has a mode where it does nothing; they are always on. Where
  `enabled` exists, default it to whatever keeps the mod's main claim on the
  user modest: `true` for wait-ship (drafting costs nothing until you act on
  a draft) and for wait-changed (the list is read-only, and `Don't show again` turns
  it off), `false` for wait-breathe (its claim is on your attention, not your
  screen). wait-ping's `enabled` defaults to `true` for the same reason as
  wait-changed: it is its own install, not part of the four rooms. Its `sound`
  defaults to `false`, and `thresholdSeconds` defaults to 30, so a shorter
  turn does not notify when it ends.

## OpenCode prototypes

[`wait-review-opencode`](wait-review-opencode) and
[`bet-on-your-agent-opencode`](bet-on-your-agent-opencode) are unpublished
prototypes of the same two mods for [OpenCode](https://opencode.ai)'s own
plugin API. Each reuses its Claude Code counterpart's engine-free core
(`hooks/diff.ts`, `hooks/bet.ts`) unmodified; each README explains what's
ported and what's blocked on OpenCode's API rather than merely unported.
**bet-on-your-agent-opencode** has since been run as a real plugin inside a
real, pty-driven OpenCode 1.19.3 TUI session — installed the same way a user
would, through the TUI's own "Install plugin" dialog — which is how a real
`api.kv` restart across two processes and a narrow-terminal layout bug (since
fixed) were found. **wait-review-opencode** is still verified by type-checking
against the real OpenCode/OpenTUI packages rather than a live session, since
exercising it needs a configured model provider this environment doesn't
have. Either way: adapter-only, not installable through this marketplace,
not versioned, not part of a release — see each README's own "How this was
verified" section for the full detail.

## Repository layout

```text
wait-review/                  pane
bet-on-your-agent/            row above the prompt
wait-ship/                    row above the prompt
wait-breathe/                 row above the prompt · off until /breathe
wait-changed/                 same row, after the turn · separate install
waitroom/                     four-room install
docs/demo.gif                 session capture used as the README demo
docs/demo.mp4                 full-length cut of that session
docs/brand/                   pixel README lockup
ads/assets/                   pixel promo placeholders
wait-ping/                    local notification · separate install
wait-scope/                   outside-scope warning · separate install
wait-review-opencode/         unpublished OpenCode prototype
bet-on-your-agent-opencode/   unpublished OpenCode prototype
```
