# bet-on-your-agent

A Claude Code plugin that scores how well you call your own agent. During the
wait, you forecast how the turn will go. Afterwards it tells you how calibrated
you were.

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

While a turn runs, the pane asks two things:

- **Will it land first try?** — 50 / 65 / 80 / 90 / 95%. Resolved by your own
  verdict, which you give whenever you feel like it.
- **How many files will it touch?** — 0 / 1 / 2–3 / 4+. Resolved automatically
  from the `Edit`, `Write` and `NotebookEdit` calls the turn actually made.

Press a number for the first row, a letter for the second. You can answer one,
both, or neither.

When nothing is running, the pane shows your record:

```
Brier 0.147 over 23 turns
better than a coin flip · 12 points overconfident

said  50% · actual  60% ·  5 turns · underconfident
said  80% · actual  64% · 11 turns · overconfident
said  95% · actual  71% ·  7 turns · overconfident

files called 14/23 · lands first try 65% · median 42s
```

Every turn is recorded whether you bet on it or not, so even without forecasting
you accumulate the thing that is genuinely hard to intuit: how often your agent
actually lands it, how many files it actually touches, and how long it actually
takes.

## Commands

| Command | What it does |
| --- | --- |
| `/bet` | Prints your Brier score and calibration table |

## Settings

| Option | Default | What it means |
| --- | --- | --- |
| `autoOpen` | `true` | Open the pane when the session starts. |

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
  unanswered costs you nothing but the sample.
- **"Landed" is your judgement**, which is the honest design: the thing being
  calibrated is your judgement, so it is also the ground truth.

History is kept in the plugin's own store, so it survives across sessions.
It holds the last 500 turns.

## Developing

```
claude plugin validate .     # manifest and hooks, as the engine reads them
claude plugin test .         # 20 tests
```

The scoring lives in `hooks/bet.ts` with no engine dependency and is tested
directly; `hooks/register.tsx` is the hooks module and `types/index.d.ts` the
state contract.
