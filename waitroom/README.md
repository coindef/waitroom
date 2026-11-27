# waitroom

One install for the three rooms. It adds no pane and no row of its own.
Its one command is `/waitroom doctor`, a local, read-only health check.
Installing it installs:

- [bet-on-your-agent](../bet-on-your-agent)
- [wait-ship](../wait-ship)
- [wait-breathe](../wait-breathe)

```sh
claude plugin marketplace add coindef/waitroom && claude plugin install waitroom@waitroom
```

That installs the three rooms above. The first interactive session logs one short tip in the transcript — the three rooms, that wait-breathe stays off until `/breathe`, and the optional wait-ping install — and does not log it again; there is no pane or row for it.

## /waitroom doctor

At the prompt, run:

```
/waitroom doctor
```

When the installed rooms look healthy, it prints one line, with the real room count and the Claude Code version, for example:

```
all 12 rooms ok · claude 2.1.319
```

On Claude Code 2.1.323 and later, a room older than the status-row yield prints one line: what is wrong, then a command you can copy to update that plugin. The command is not run for you. Earlier Claude Code builds do not flag that.

The check does not write the store or anything under the Claude configuration directory.

Optional — local notification when a long turn ends (not in the three-room install):

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
