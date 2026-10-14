# bet-on-your-agent

A Claude Code plugin that scores how well you call your own agent. While a turn
runs, the row above the prompt asks you how it will go. Afterwards it tells you
how calibrated you were.

```
/plugin install bet-on-your-agent --marketplace coindef/Plugin
```

(Answer `y` to add the marketplace, then pick a scope.)

## Why calibration, not a wager

The most valuable skill in agentic coding is knowing how far to trust the agent
on the task in front of you, and how much context it needs to get there. Right
now that skill is learned entirely by vibes.

So this keeps no currency and no winnings. Guessing well against a house teaches
you to guess; being scored on your honesty teaches you to judge. It uses the
**Brier score** — the mean squared error of a forecast against what happened —
which is a *proper* scoring rule: you cannot improve it by shading an answer
away from what you actually believe. The payoff is not a number, it is the line
that says you run twelve points overconfident on the turns you call at 90%.

The forecast also fits the wait exactly. It takes one keypress, it is about the
thing already on your mind, and the window closes on its own when the turn
lands.

## What it does

It lives in the row above the prompt, which is where you are already looking
while you wait. **Type a bare digit into an empty composer and it answers** —
no pane to place, no focus to manage, nothing to click.

```
Will "add the retry logic to the client" land first try?  1: 50% 2: 65% 3: 80% 4: 90% 5: 95%
```

Answer that and it asks the next thing, never both at once, so the digits
always mean the obvious thing:

```
80% · how many files?  1: 0  2: 1  3: 2-3  4: 4+
```

- **Will it land first try?** Resolved by your own verdict, which it asks for
  once the turn lands — with a `skip` if you would rather not say.
- **How many files?** Resolved automatically from the `Edit`, `Write` and
  `NotebookEdit` calls the turn actually made, so it needs no verdict at all.

The forecast is quoted against **what you asked for**, which is the point: a
score tells you that you are overconfident, the ask tells you what about.

`/bet` opens the record:

```
You run 12 points overconfident.
Brier 0.147 over 23 turns · better than a coin flip

said  50% · actual  60% ·  5 turns · underconfident
said  80% · actual  64% · 11 turns · overconfident
said  95% · actual  71% ·  7 turns · overconfident

Worst calls
95% and it did not — refactor the auth layer to use the new client
95% and it did not — make the config loader handle overrides
80% and it did not — rename the session helpers

files called 14/23 · lands first try 65% · median 42s
```

The headline is in words because "Brier 0.147" means nothing on its own. The
table is the part that teaches, and **Worst calls** is the part that teaches
fastest: it is always a specific kind of ask you misjudge, not forecasting in
general.

Every turn is recorded whether you bet on it or not, so even without forecasting
you accumulate the thing that is genuinely hard to intuit: how often your agent
actually lands it, how many files it actually touches, and how long it actually
takes.

## Commands

| Command | What it does |
| --- | --- |
| `/bet` | Prints your record and opens the pane |

## Settings

| Option | Default | What it means |
| --- | --- | --- |
| `autoOpen` | `false` | Open the record pane at session start. Off by default: betting lives in the band, so the pane is only worth space when you want to read the record. |

## How the scoring works

- **Brier score** is the mean of `(forecast − outcome)²`. Lower is better.
  Saying 50% every time scores exactly `0.25`, so anything under that beats no
  skill at all, and anything over it means your confidence is actively
  misleading you.
- **The calibration table** is the part worth reading. One row per forecast you
  actually used, because a single score hides *which kind* of turn you misjudge.
- **Interrupted turns are recorded but never scored.** Stopping a turn yourself
  says nothing about the agent.
- **A bet with no verdict waits.** It is never counted as a loss, so leaving one
  unanswered costs you nothing but the sample. Press `skip` and it is dropped
  from scoring entirely while the turn stays on the record.
- **A call that was nearly right is never held up as a worst call.** Only a miss
  wider than a coin flip makes that list.
- **"Landed" is your judgement**, which is the honest design: the thing being
  calibrated is your judgement, so it is also the ground truth.

History is kept in the plugin's own store, so it survives across sessions.
It holds the last 500 turns.

## Developing

```
claude plugin validate .     # manifest and hooks, as the engine reads them
claude plugin test .         # 31 tests
```

The scoring lives in `hooks/bet.ts` with no engine dependency and is tested
directly; `hooks/register.tsx` is the hooks module and `types/index.d.ts` the
state contract. `tests/band.test.tsx` drives the whole loop through the engine:
place a bet while a turn runs, land the turn, answer the verdict, and read the
call back out of the record.
