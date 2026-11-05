<p align="center"><img src="docs/brand/waitroom-social-1280x640-v8c.png" width="720" alt="Waitroom"></p>

<h2 align="center">Claude is thinking. Call the turn.</h2>

<p align="center"><sub>Here's something to do while you wait.</sub></p>

<p align="center"><sub>If it saved you a boring minute, a star helps.</sub></p>

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install bet-on-your-agent@waitroom
claude plugin install wait-breathe@waitroom
claude plugin install wait-ship@waitroom
```

<p align="center"><img src="docs/bet-demo.gif" width="640" alt="A real Claude Code session: you ask Claude to change src/retry.ts, the bet row asks whether it will land first try and you call 90%, then 2 to 3 files; the turn runs, the row asks Did it land?, you answer Landed, and it records the call toward your calibration score"></p>

## Rooms

### Core

| | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Room&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | What it does |
|---|---|---|
| <img src="docs/brand/plugin-icons/bet.png" width="52" alt="bet-on-your-agent icon"> | [bet-on-your-agent](./bet-on-your-agent) | **Call the turn. Get scored.**<br>Call how the turn will go, then see how well your calls match what happened. The status row, on by default. |
| <img src="docs/brand/plugin-icons/breathe.png" width="52" alt="wait-breathe icon"> | [wait-breathe](./wait-breathe) | **Your lungs need a turn too.**<br>Shows one quiet line during a long turn, such as an eye break or a stretch. The status row, off until you run /breathe. |
| <img src="docs/brand/plugin-icons/notify.png" width="52" alt="wait-notify icon"> | wait-notify | **Go outside. We'll yell.**<br>Coming soon. A macOS notification when Claude needs input, and one reminder after 3 idle minutes. |
| <img src="docs/brand/plugin-icons/ship.png" width="52" alt="wait-ship icon"> | [wait-ship](./wait-ship) | **Commit msg? Already cooked.**<br>Drafts the commit message, PR description, and changelog entry for you to review. The status row, on by default. |

### Optional

| | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Room&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | What it does |
|---|---|---|
| <img src="wait-secret/.claude-plugin/icon.png" width="32" height="32" alt="wait-secret icon"> | [wait-secret](./wait-secret) | Flags lines a turn wrote that look like a key or a token. Local only, and it only warns. The status row, after the turn ends. |
| <img src="wait-scope/.claude-plugin/icon.png" width="32" height="32" alt="wait-scope icon"> | [wait-scope](./wait-scope) | Flags files a turn edited outside the scope you set, and never blocks them. The status row, on by default. |
| <img src="wait-ping/.claude-plugin/icon.png" width="32" height="32" alt="wait-ping icon"> | [wait-ping](./wait-ping) | Local OS notification when a long turn ends or a permission confirm is waiting. Will be replaced by wait-notify. |

How the rooms share the screen is in [docs/design.md](docs/design.md).

## Install

The command above installs bet-on-your-agent, wait-breathe, and wait-ship. Optional rooms install on their own:

```sh
claude plugin install wait-secret@waitroom
claude plugin install wait-scope@waitroom
claude plugin install wait-ping@waitroom
```

Restart Claude Code afterwards. Requires Claude Code 2.1.291 or later, and a git repository for wait-ship. Single-plugin installs and updates are in [docs/install.md](docs/install.md).

---

[Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · MIT, see [LICENSE](LICENSE).
