# wait-mods

Two Claude Code plugins for the dead time while a coding agent works.

```
/plugin install wait-review       --marketplace coindef/Plugin
/plugin install bet-on-your-agent --marketplace coindef/Plugin
```

(Answer `y` to add the marketplace, then pick a scope.)

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
is only available *during* the wait, needs no context switch to start, and can be
abandoned mid-thought:

- **wait-review** spends it on the diff, because the agent now writes code
  faster than anyone reads it and a session otherwise ends with a large diff
  nobody reviewed.
- **bet-on-your-agent** spends it on a forecast, because knowing how far to
  trust the agent is the skill that matters most and is currently learned by
  vibes.

They compose rather than compete for room: **wait-review** takes the pane, and
**bet-on-your-agent** takes the single row above the prompt, where a bare digit
answers it. One asks what you make of what the agent wrote, the other what you
expect from what it is writing.

## Developing

Each mod is a self-contained plugin folder. From the repository root:

```
claude plugin validate ./wait-review
claude plugin test     ./wait-review          # 43 tests

claude plugin validate ./bet-on-your-agent
claude plugin test     ./bet-on-your-agent    # 31 tests
```

Run a working copy without installing it:

```
claude --plugin-dir /path/to/Plugin/wait-review
```

Each mod keeps the logic that needs no engine in one plain module
(`hooks/diff.ts`, `hooks/bet.ts`) so it can be tested directly, with the hooks
module beside it and a `types/index.d.ts` state contract that
`claude plugin validate` holds it to.

`.claude-plugin/types/` inside a mod is written by the engine on each load and
is not checked in.
