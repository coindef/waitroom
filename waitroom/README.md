# waitroom

One install for the four rooms. It adds no pane, no row, and no command of
its own. Installing it installs:

- [wait-review](../wait-review)
- [bet-on-your-agent](../bet-on-your-agent)
- [wait-ship](../wait-ship)
- [wait-breathe](../wait-breathe)

[wait-changed](../wait-changed) stays a separate install.

```sh
claude plugin marketplace add coindef/waitroom && claude plugin install waitroom@waitroom
```

At the Claude Code prompt, send these as two messages:

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install waitroom@waitroom
```

Each room still installs on its own, with the command in that room's README.
wait-breathe stays off until `/breathe`. Both lines are safe to run again.
