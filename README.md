# waitroom

Two Claude Code plugins for the dead time while a coding agent works. The wait
is the one moment you are already holding the problem in your head and have
nothing to do with it; these spend it on the diff the agent just wrote, and on
how well you called the turn.

![Claude Code with the review pane docked on the right, a colored diff of the change Claude just made, and a row above the prompt asking how the running turn will go](docs/waitroom.svg)

*A real session, not a mockup: Claude Code 2.1.302 with both mods. On the right,
the diff Claude already wrote, a hunk at a time. Above the prompt, a one-keystroke
forecast for the turn it is running now.*

## Install

Send these at the Claude Code prompt, each as its own message:

```
/plugin marketplace add coindef/waitroom
```
```
/plugin install wait-review@waitroom
```
```
/plugin install bet-on-your-agent@waitroom
```

Each install shows the plugin's options on the way in. Every option has a
working default, so save them as they are; it answers `Installed and configured
wait-review. Plugin is now active.` That is the whole install — active in that
session straight away, and in every session after it. No key, no service, and
nothing written to your repository. Skip the last line if you only want
wait-review.

Every line is safe to send again: adding a marketplace that is already there,
or installing a plugin that already is, changes nothing. So when in doubt, send
all three — then `/plugin` should read `2 mods active · wait-review,
bet-on-your-agent`.

It needs **Claude Code 2.1.292 or later** — `claude --version` says which you
have, `claude update` moves you on. An older build installs it without
complaint and then shows it as `failed to load`; see
[If a plugin shows an error](#if-a-plugin-shows-an-error).

The first line adds the marketplace from its repository path,
`coindef/waitroom`. From then on it goes by its name, **`waitroom`** — the part
after the `@`.

You may also see the one-line form, `/plugin install wait-review --marketplace
coindef/waitroom`. It works once. Sent again, it answers `Plugin "wait-review"
not found in any marketplace`, because by then `--marketplace` wants the name
`waitroom`, not the repository path. The three lines above have no such trap.

### Updating

Run these at the prompt, then **restart Claude Code** — an update is written to
disk straight away but only loaded by the next session:

```
/plugin marketplace update waitroom
/plugin update wait-review@waitroom
/plugin update bet-on-your-agent@waitroom
```

Each reports `updated from` the old version `to` the new one, or `already at
the latest version` for a mod that has not changed. What changed, and in which
mod, is in [CHANGELOG.md](./CHANGELOG.md); if one it lists as changed still
says it is at the latest version, the marketplace was not refreshed yet, so run
the first line again.

### Coming from the old name

The repository was called `Plugin`, and the marketplace `wait-mods` (in the
very first release, `wait-review`). If you installed under one of those, the
stale marketplace is still registered and has to go before the new one can take
its place. `/plugin marketplace list` shows which you have. Removing a
marketplace uninstalls the plugins that came from it, so remove the old one,
then install again:

```
/plugin marketplace remove wait-mods
/plugin marketplace add coindef/waitroom
/plugin install wait-review@waitroom
/plugin install bet-on-your-agent@waitroom
```

(From the first release, the first line is `/plugin marketplace remove
wait-review` instead.) Leave the old one in place and one of the two copies
reports `holds the same plugin name and comes first` — see
[If a plugin shows an error](#if-a-plugin-shows-an-error).

bet-on-your-agent's record does not come with it: each install keeps its own,
so your calibration starts fresh under the new name.

## Requirements

- **Claude Code 2.1.292 or later, run interactively.** 2.1.292 is the current
  stable release; tested on it, 2.1.300 and 2.1.302. Builds before 2.1.242
  cannot read the hooks module both plugins are built on, so they fail to load;
  builds in between load them but are untested. `claude update` if you are
  behind.
- **A git repository** for wait-review. It reads the diff, so outside one it
  has nothing to show. bet-on-your-agent works anywhere.
- Plugins that hook Claude Code's own events are **early access**. See
  [If a plugin shows an error](#if-a-plugin-shows-an-error).

## The first minute

**wait-review** needs no setup. Ask Claude for a change; when the turn ends, the
pane starts offering the diff a hunk at a time — here paging through a new file
longer than the pane:

<img src="docs/paging.svg" width="480" alt="The review pane showing a new file, lines 1 to 21 of 44, with controls for looks right, flag, later, skip file and undo">

**Give the pane the keys first: `ctrl+x tab`** (or click it). Its letters only
work while it holds the keyboard — press `o` without that and you type an `o`
into your prompt. The pane reminds you at the bottom, and `esc` hands the keys
back when you are done.

| Key | Does |
|---|---|
| `o` | Looks right — next hunk |
| `f` | Flag it; it goes to Claude with your next message |
| `n` | After `f`: say why, in a line |
| `l` | Later — comes back once the rest are read |
| `x` | Skip the rest of this file |
| `u` | Undo the last call |
| `j` / `k` | Read on / back through a hunk longer than the pane |

A new file is a single hunk as long as the file, so `j` matters more than it
looks: the pane shows `lines 1–30 of 200` and pages through the rest.

Running `/wait-review` opens the pane already holding the keyboard, so the
letters answer at once. The pane that opens by itself at the start of a session
deliberately does not take the keys: it would eat the first keystrokes of a
prompt you have not sent yet.

If the pane never appears, your terminal is under 144 columns — a pane nobody
asked for needs that much room. Run `/wait-review` and it opens at any width.
The status line tells you so:

```
wait-review: 3 to read · open with /wait-review
```

**bet-on-your-agent** puts a question above the prompt while a turn runs:

```
Will "add the retry logic to the client" land first try?
1: 50%  2: 65%  3: 80%  4: 90%  5: 95%  0: Skip
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
**bet-on-your-agent** takes the space just above the prompt. One asks what you
make of what the agent wrote, the other what you expect from what it is writing.

## If a plugin shows an error

**`failed to load`, or `✗ 1 error` on its row in `/plugin`, most likely means
Claude Code is too old.** The error itself reads like this:

```
Hook load failed: [ { "expected": "record", "code": "invalid_type",
  "path": [ "hooks" ], "message": "Invalid input: expected record, received undefined" } ]
```

Builds before 2.1.242 cannot read the hooks module these plugins are built on,
so every plugin built that way fails to load the same way — including ones from
other marketplaces. Run `claude update`, restart, and they load. (Reproduced on
2.1.200 and 2.1.241; 2.1.242 is the first build that reads it.)

Otherwise, check whether they are running at all. Open `/plugin`: when both are
loaded, the line under the tabs reads

```
2 mods active · wait-review, bet-on-your-agent
```

If one is missing from it, the **Errors** tab in the same menu names the reason
— so does `claude --debug`, on a line starting `hooks module wait-review@waitroom
not loaded:`. What it can say:

| It says | What it means | What to do |
| --- | --- | --- |
| `Its hooks module does not load. "wait-review@…" holds the same plugin name and comes first` | Two copies are installed — almost always one from the old `wait-mods` marketplace beside the new one | `/plugin marketplace remove wait-mods` removes the old copy with its marketplace. See [Coming from the old name](#coming-from-the-old-name) |
| `hooks modules are turned off for installed plugins in this process: …` | The early-access switch, below | Depends on the rest of the line |
| `only managed plugins and built-in plugins run (allowManagedHooksOnly / disableAllHooks)` | Your organization's managed settings allow only its own plugins' hooks | Ask whoever manages Claude Code for you |
| `… load no hooks module in this mode (--bare)` | Claude Code was started with `--bare` | Start it without `--bare` |

No error anywhere, and no `mods active` line at all, means `disableAllHooks` is
on in your settings. It turns off every hook, these included.

The same "holds the same plugin name" error appears if you run
`claude --plugin-dir ./wait-review` while the installed copy is enabled. Disable
the installed one while you work on a clone.

### The early-access switch

Plugins that hook the engine's own events are **early access**, gated by a
rollout switch. The end of the line says which state it is in:

- **`this wake's flag fetch has not answered the rollout switch`** is the
  harmless case. The process started before the answer arrived, and the mods
  load at the next turn start once it does — the debug log then shows `…
  loaded (worker, environment 4, tier user)`. A short `claude -p` run can end
  in that gap; an interactive session never does.
- **`the rollout switch was saved off by an earlier session and is not refreshed
  yet`** is a stale answer. Start `claude` once with network access and it
  refreshes.
- **`the rollout switch served off`** means the switch is off for this build or
  account. Nothing in these mods can turn it on, and they load by themselves
  once it reads on.

Either way the switch is not about these mods in particular: it holds back
every installed plugin that carries a hooks module, whoever made it.

## What the installer says on the way in

**"4 userConfig options not yet set"** is informational: every option has a
working default and the plugin runs on them — the debug log puts it as `every
option is its default`. Configure them to change something, not to get started.

## Developing

Each mod is a self-contained plugin folder. From the repository root:

```
claude plugin validate ./wait-review
claude plugin test     ./wait-review          # 65 tests

claude plugin validate ./bet-on-your-agent
claude plugin test     ./bet-on-your-agent    # 41 tests
```

Neither of those runs a real type checker, so also run `tsc` from each mod's
folder once it has loaded at least once (that's what writes
`.claude-plugin/types/`, which the mod's `tsconfig.json` points at):

```
npx -y -p typescript@5.7 tsc -p .
```

(`typescript@latest` currently ships a rewritten `tsc` whose CLI rejects
`-p` outright — pin a 5.x release rather than chasing that down again.) A
clean run prints nothing. This caught a real bug once already (two call
sites where a status literal silently widened to `string` inside a `.map`,
erasing the protection `HunkStatus` was there to give) that 84 passing tests
and a clean `validate` both missed — run it after any change to either
mod's `hooks/`, not just when something looks wrong.

Run a working copy without installing it, or install from this clone so edits
reload in place:

```
claude --plugin-dir ./wait-review
# or
claude plugin marketplace add .     # then /plugin install <mod>@waitroom
```

Each mod keeps the logic that needs no engine in one plain module
(`hooks/diff.ts`, `hooks/bet.ts`) so it can be tested directly, with the hooks
module beside it and a `types/index.d.ts` state contract that
`claude plugin validate` holds it to. `tests/flow.test.ts` and
`tests/band.test.tsx` drive the real loops through the engine, git and all.

`.claude-plugin/types/` inside a mod is written by the engine on each load and
is not checked in.

## License

MIT — see [LICENSE](./LICENSE). What changed in each release is in
[CHANGELOG.md](./CHANGELOG.md).
