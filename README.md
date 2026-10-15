# waitroom

Two Claude Code plugins for the dead time while a coding agent works. The wait
is the one moment you are already holding the problem in your head and have
nothing to do with it; these spend it on the diff the agent just wrote, and on
how well you called the turn.

## Install

```
/plugin install wait-review --marketplace coindef/waitroom
```

Answer `y` to add the marketplace, then Enter to accept the user scope. That is
the whole install — the plugin is active in that session straight away, and in
every session after it. Nothing to configure, no key, no service, and nothing
written to your repository.

**Once the marketplace is added it is called `waitroom`**, so the second mod,
and anything you install later, goes by that name rather than by the repository:

```
/plugin install bet-on-your-agent@waitroom
```

Using `--marketplace coindef/waitroom` a second time answers
`Plugin "..." not found in any marketplace`, because that flag takes the name a
marketplace was added under, and the add step has already happened.

Start with `wait-review` if you only want one.

## The first minute

**wait-review** needs no setup. Ask Claude for a change; when the turn ends, the
pane starts offering the diff a hunk at a time:

```
2 to read · 1 read                                   Claude is working

src/auth/session.ts                                      file 1 of 2
line 42 · +3 −1                            2 left here · 3 left
────────────────────────────────────────────────────────────────────
  42   const sent = await fetch(url)
  43 - if (!sent.ok) return retry(url)
  43 + if (!sent.ok) return undefined
  44   return sent.json()

o: Looks right   f: Flag   l: Later   x: Skip file
```

Press the letter. That is the whole interface. Flag something and your reason
goes to Claude with your next message.

If the pane never appears, your terminal is under 144 columns — a pane nobody
asked for needs that much room. Run `/wait-review` and it opens at any width.
The status line tells you so:

```
review: 3 to read · /wait-review
```

**bet-on-your-agent** puts one row above the prompt while a turn runs:

```
Will "add the retry logic to the client" land first try?  1: 50% 2: 65% 3: 80% 4: 90% 5: 95% 0: skip
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
**bet-on-your-agent** takes the single row above the prompt. One asks what you
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
claude plugin test     ./wait-review          # 48 tests

claude plugin validate ./bet-on-your-agent
claude plugin test     ./bet-on-your-agent    # 34 tests
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
