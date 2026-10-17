# waitroom

Two Claude Code plugins for the dead time while a coding agent works. The wait
is the one moment you are already holding the problem in your head and have
nothing to do with it; these spend it on the diff the agent just wrote, and on
how well you called the turn.

![Claude Code with the review pane docked on the right, a colored diff of the change Claude just made, and a row above the prompt asking how the running turn will go](docs/waitroom.svg)

*A real session, not a mockup: Claude Code 2.1.302 with both mods. On the right,
the diff Claude already wrote, a hunk at a time. Above the prompt, a one-keystroke
forecast for the turn it is running now.*

## Install

```
/plugin install wait-review --marketplace coindef/waitroom
```

Answer `y` to add the marketplace, then Enter to accept the user scope. That is
the whole install — the plugin is active in that session straight away, and in
every session after it. Nothing to configure, no key, no service, and nothing
written to your repository.

The source is the repository path; the marketplace it adds is called
**`waitroom`**, which is the name everything after the first install goes by:

```
/plugin install bet-on-your-agent@waitroom
```

`--marketplace` takes one of two things, and mixing them up is the one way to
get this wrong:

- **a repository path**, on the first install, to fetch and add the marketplace
- **a marketplace name**, afterwards, because the add has already happened

So `--marketplace coindef/waitroom` a second time answers `Plugin "..." not found
in any marketplace` — by then the marketplace is called `waitroom`, and a
repository path is not a marketplace name. A path to a repository that does not
exist answers the same way.

Start with `wait-review` if you only want one.

## Requirements

- **Claude Code, run interactively.** Tested on 2.1.300 and 2.1.302. Check with
  `claude --version`; if you are on something older, `claude update` first —
  it is the likeliest fix if a plugin shows an error after installing.
- **A git repository** for wait-review. It reads the diff, so outside one it
  has nothing to show. bet-on-your-agent works anywhere.
- Plugins that hook Claude Code's own events are **early access**. See
  [If a plugin shows an error](#if-a-plugin-shows-an-error).

## The first minute

**wait-review** needs no setup. Ask Claude for a change; when the turn ends, the
pane starts offering the diff a hunk at a time — here paging through a new file
longer than the pane:

<img src="docs/paging.svg" width="480" alt="The review pane showing a new file, lines 1 to 21 of 44, with controls for looks right, flag, later, skip file and undo">

**Give the pane the keys first: `ctrl+x tab`** (or click it). Its letters only
work while it holds the keyboard — press `o` without that and you type an `o`
into your prompt. The pane reminds you at the bottom, and `esc` hands the keys
back when you are done.

| Key | Does |
|---|---|
| `o` | Looks right — next hunk |
| `f` | Flag it; it goes to Claude with your next message |
| `n` | After `f`: say why, in a line |
| `l` | Later — comes back once the rest are read |
| `x` | Skip the rest of this file |
| `u` | Undo the last call |
| `j` / `k` | Read on / back through a hunk longer than the pane |

A new file is a single hunk as long as the file, so `j` matters more than it
looks: the pane shows `lines 1–30 of 200` and pages through the rest.

If the pane never appears, your terminal is under 144 columns — a pane nobody
asked for needs that much room. Run `/wait-review` and it opens at any width.
The status line tells you so:

```
wait-review: 3 to read · open with /wait-review
```

**bet-on-your-agent** puts a question above the prompt while a turn runs:

```
Will "add the retry logic to the client" land first try?
1: 50%  2: 65%  3: 80%  4: 90%  5: 95%  0: skip
```

Type a bare digit into the empty composer and it answers — no pane, no focus,
no click. `/bet` shows what it has learned about you.

## What they are

| Mod | What it does |
| --- | --- |
| [**wait-review**](./wait-review) | Offers the diff the agent already wrote, one hunk at a time, and sends what you flag — with your reason — back with your next message. |
| [**bet-on-your-agent**](./bet-on-your-agent) | Forecast how the turn will go from the row above the prompt, then get a Brier score and a calibration table. |

## The idea behind both

The cost of waiting on a coding agent is not boredom, it is context collapse. A
90-second wait filled with something entertaining costs minutes of refocus on
the way back, and any game with a win condition quietly teaches you to want the
agent to be slow. You also cannot win on entertainment: the person already has a
phone.

So neither of these competes with a phone. Both spend the wait on something that
is only available *during* the wait, needs no context switch to start, and can
be abandoned mid-thought:

- **wait-review** spends it on the diff, because the agent now writes code
  faster than anyone reads it and a session otherwise ends with a large diff
  nobody reviewed.
- **bet-on-your-agent** spends it on a forecast, because knowing how far to
  trust the agent is the skill that matters most and is currently learned by
  vibes.

They compose rather than compete for room: **wait-review** takes the pane, and
**bet-on-your-agent** takes the space just above the prompt. One asks what you
make of what the agent wrote, the other what you expect from what it is writing.

## If a plugin shows an error

Plugins that hook the engine's own events are **early access**, gated by a
rollout switch. Two different things can happen, and the debug log
(`claude --debug`) tells them apart. Both read:

```
hooks module wait-review@waitroom not loaded: hooks modules are turned off for
installed plugins in this process: this wake's flag fetch has not answered the
rollout switch
```

- **A line like that followed, under a second later, by `… loaded (worker,
  environment 4, tier user); events: session.start,…`** is the harmless case:
  the switch is on and the process simply started before the answer arrived. A
  short `claude -p` run can end in that gap; an interactive session never does.
- **That line with no `loaded` after it** means the switch is off for this
  build or account. Nothing in these mods can turn it on, and they load by
  themselves once it reads on.

A quick way to tell which you have: every plugin that carries a hooks module
will show the error, including ones from other marketplaces that have nothing
to do with these. If the only healthy plugins you have left are skill-and-
command ones, it is the switch, not the mod.

## What the installer says on the way in

**"4 userConfig options not yet set"** is informational: every option has a
working default and the plugin runs on them — the debug log puts it as `every
option is its default`. Configure them to change something, not to get started.

## Developing

Each mod is a self-contained plugin folder. From the repository root:

```
claude plugin validate ./wait-review
claude plugin test     ./wait-review          # 64 tests

claude plugin validate ./bet-on-your-agent
claude plugin test     ./bet-on-your-agent    # 36 tests
```

Run a working copy without installing it, or install from this clone so edits
reload in place:

```
claude --plugin-dir ./wait-review
# or
claude plugin marketplace add .     # then /plugin install <mod> --marketplace waitroom
```

Each mod keeps the logic that needs no engine in one plain module
(`hooks/diff.ts`, `hooks/bet.ts`) so it can be tested directly, with the hooks
module beside it and a `types/index.d.ts` state contract that
`claude plugin validate` holds it to. `tests/flow.test.ts` and
`tests/band.test.tsx` drive the real loops through the engine, git and all.

`.claude-plugin/types/` inside a mod is written by the engine on each load and
is not checked in.

## License

MIT — see [LICENSE](./LICENSE). What changed in each release is in
[CHANGELOG.md](./CHANGELOG.md).
