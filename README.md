<p align="center">
  <img src="docs/brand/A-hero-B-final2.png" srcset="docs/brand/A-hero-B-final2.png 1x, docs/brand/A-hero-B-final2@2x.png 2x" width="720" alt="Waitroom: seven pixel icons for the seven plugins">
</p>

<h1 align="center">Waitroom</h1>

<p align="center">While Claude works, review its diff one hunk at a time.</p>

<p align="center">
  <img src="docs/first-screen.gif" width="720" alt="The wait-review pane in a real Claude Code session: the diff arrives while Claude works, and one hunk gets flagged with a reason">
</p>

<p align="center">If it saved you a boring minute, a star helps.</p>

```sh
claude plugin marketplace add coindef/waitroom && claude plugin install waitroom@waitroom
```

## Rooms

| | Room | What it does |
|---|---|---|
| <img src="wait-review/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-review](./wait-review) | Review the diff Claude already wrote, a hunk at a time, and send what you flag with your next message. A pane, on by default. |
| <img src="bet-on-your-agent/.claude-plugin/icon.png" width="32" height="32" alt=""> | [bet-on-your-agent](./bet-on-your-agent) | Call how the turn will go, then see how well your calls match what happened. The status row, on by default. |
| <img src="wait-ship/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-ship](./wait-ship) | Drafts the commit message, PR description, and changelog entry for you to review. The status row, on by default. |
| <img src="wait-breathe/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-breathe](./wait-breathe) | Shows one quiet line during a long turn, such as an eye break or a stretch. The status row, off until you run /breathe. |
| <img src="wait-changed/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-changed](./wait-changed) | Lists the files a turn changed after the turn ends. The status row, on by default. |
| <img src="wait-ping/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-ping](./wait-ping) | Sends a local notification when a long turn ends or a permission prompt is waiting. On by default. |
| <img src="wait-scope/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-scope](./wait-scope) | Flags files a turn edited outside the scope you set, and never blocks them. The status row, on by default. |
| <img src="wait-secret/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-secret](./wait-secret) | Flags likely secrets in files the turn changed. The status row, on by default. |
| <img src="wait-shell/.claude-plugin/icon.png" width="32" height="32" alt=""> | [wait-shell](./wait-shell) | Lists the shell commands the turn ran. The status row, on by default. |

How the rooms share the screen is in [docs/design.md](docs/design.md).

## Install

The command above installs wait-review, bet-on-your-agent, wait-ship, and wait-breathe. Add the others one at a time:

```sh
claude plugin install wait-changed@waitroom
claude plugin install wait-ping@waitroom
claude plugin install wait-scope@waitroom
claude plugin install wait-secret@waitroom
claude plugin install wait-shell@waitroom
```

Restart Claude Code afterwards. Requires Claude Code 2.1.291 or later, and a git repository for wait-review and wait-ship. Single-plugin installs and updates are in [docs/install.md](docs/install.md).

---

[Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · MIT, see [LICENSE](LICENSE).
