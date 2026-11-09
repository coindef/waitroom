# Troubleshooting

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

Otherwise, check whether they are running at all. Open `/plugin`: when all
three are loaded, the line under the tabs reads

```
3 mods active · bet-on-your-agent, wait-ship, wait-breathe
```

If one is missing from it, the **Errors** tab in the same menu names the reason
— so does `claude --debug`, on a line starting `hooks module bet-on-your-agent@waitroom
not loaded:`. What it can say:

| It says | What it means | What to do |
| --- | --- | --- |
| `Its hooks module does not load. "bet-on-your-agent@…" holds the same plugin name and comes first` | Two copies are installed — almost always one from the old `wait-mods` marketplace beside the new one | `/plugin marketplace remove wait-mods` removes the old copy with its marketplace. See [Coming from the old name](install.md#coming-from-the-old-name) |
| `hooks modules are turned off for installed plugins in this process: …` | The early-access switch, below | Depends on the rest of the line |
| `only managed plugins and built-in plugins run (allowManagedHooksOnly / disableAllHooks)` | Your organization's managed settings allow only its own plugins' hooks | Ask whoever manages Claude Code for you |
| `… load no hooks module in this mode (--bare)` | Claude Code was started with `--bare` | Start it without `--bare` |

### Dependency "wait-review@waitroom" is not installed

That error after a marketplace update means a leftover install from before wait-review was removed. wait-review was removed on purpose. Follow the three uninstall/install commands in [If waitroom fails after a marketplace update](install.md#if-waitroom-fails-after-a-marketplace-update).

No error anywhere, and no `mods active` line at all, means `disableAllHooks` is
on in your settings. It turns off every hook, these included.

The same "holds the same plugin name" error appears if you run
`claude --plugin-dir ./bet-on-your-agent` while the installed copy is enabled. Disable
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
