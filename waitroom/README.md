# waitroom

One install for the four rooms. It adds no pane, no row, and no command of
its own. Installing it installs:

- [wait-review](../wait-review)
- [bet-on-your-agent](../bet-on-your-agent)
- [wait-ship](../wait-ship)
- [wait-breathe](../wait-breathe)

```sh
claude plugin marketplace add coindef/waitroom && claude plugin install waitroom@waitroom
```

That installs the four rooms above. The first interactive session logs one short tip in the transcript — the four rooms, that wait-breathe stays off until `/breathe`, and the optional wait-changed install — and does not log it again; there is no pane or row for it.

Optional — turn-end file list (not in the four-room install):

```sh
claude plugin install wait-changed@waitroom
```

After a turn that changed files, lists them above the prompt. Read-only. Skip if you only want the four rooms. [What it shows](../wait-changed).

Optional — local notification when a long turn ends (not in the four-room install):

```sh
claude plugin install wait-ping@waitroom
```

A turn under 30 seconds ends quietly. Sound stays off until you turn it on. [What it sends](../wait-ping).

At the Claude Code prompt, send these as two messages:

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install waitroom@waitroom
```

Each room still installs on its own, with the command in that room's README.
wait-breathe stays off until `/breathe`. Both lines are safe to run again.
