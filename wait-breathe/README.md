# wait-breathe

A Claude Code plugin that asks you, once in a while, to take care of yourself
during a long turn. Off by default.

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-breathe@waitroom
```

(Each as its own message; both are safe to send again. Needs Claude Code
2.1.291 or later; `claude update` if `claude --version` says otherwise.)

## Why this is off by default

Every other mod in this marketplace earns its place by giving the wait
something to do. This one does the opposite on purpose: the only thing it asks
is that you, not the agent, get a turn once a session runs long. That is a
different kind of claim on your attention, and not everyone wants a plugin
making it — so it stays silent until you turn it on.

**To turn it on:** check *Enable the breathing nudges* on this mod's install
screen, or open it any time after with `/plugin` → `wait-breathe`. `/breathe`
tells you, at any point, whether it is on and exactly where that option lives.

## What it does

Turn on `enabled` and nothing changes about a normal turn. Only once a single
turn runs past `longTurnSeconds` (90 by default) does one line show up in the
row above the prompt — the same row `bet-on-your-agent` uses:

<img src="../docs/breathe-nudge.svg" width="400" alt="The row above the prompt: a breathe tag, '4-4-4 breathing: in for 4, hold for 4, out for 4', and the b: Took it key">

```
 breathe  4-4-4 breathing: in for 4, hold for 4, out for 4
```

That's the whole interaction. No health claim, no "you should," just the
action: posture check, a 20-20-20 eye break, 4-4-4 breathing, or stand up and
stretch — rotating in that order, so it is never the same one twice running.
If you want it counted, `b: Took it`; if not, carry on and it clears itself
once the turn ends either way.

- **At most one line per turn.** However long the turn keeps running past the
  threshold, it already said its one thing.
- **At most one line every ten minutes**, regardless of how many turns run
  long in between.
- **Zero required keys.** Nothing here ever needs an answer — not even the
  `Took it` button, which only exists to let the count mean something.
- **It yields to a real survey.** If the band is already asking you something
  else — `bet-on-your-agent`'s forecast, say — this waits rather than stack a
  second row of buttons on top.

At the end of the session, one line sums it up, the same way `wait-review`
sums up a session's reading:

```
breathe: 3 prompts, 2 taken this session
```

Said only when at least one nudge actually showed. A quiet session — nothing
ran long, or the plugin is off — ends with no line at all.

## Commands

| Command | What it does |
| --- | --- |
| `/breathe` | One line: whether the nudges are on, the threshold either way, and how to flip it |

```
breathe: off · would nudge after a turn runs 90s · turn on in /plugin → wait-breathe → Enable the breathing nudges
```

This is the one place to find this mod again once the install screen has
scrolled past — there is no pane and no band entry to stumble into otherwise.

## Settings

| Option | Default | What it means |
| --- | --- | --- |
| `enabled` | `false` | Turn the nudges on. Off means zero output, ever. |
| `longTurnSeconds` | `90` | How long a single turn runs before one nudge appears. |

## What it does not do

- **No sensors, no biometrics, no timers outside the turn you are already
  waiting on.** It reads nothing about you — only how long the current turn
  has been running.
- **No health claims.** Each nudge names an action, never a benefit. This is
  not medical advice and does not pretend to be.
- **No network, no account, no telemetry.** Everything it keeps lives in its
  own local store, the same as `bet-on-your-agent`'s record.
- **Nothing here blocks a turn.** A failure in this plugin never swallows a
  prompt or an edit — the hooks that would gate anything simply pass the call
  through.

## Developing

```
claude plugin validate .     # manifest and hooks, as the engine reads them
claude plugin test .         # 20 tests
```

The rotation, the cooldown and the session counting live in `hooks/breathe.ts`
with no engine dependency and are tested directly; `hooks/register.tsx` is the
hooks module and `types/index.d.ts` the state contract. `tests/flow.test.tsx`
drives the whole loop through the engine with the mock clock, arming the
threshold at `turn.start` and advancing past it the way a real long turn would.
