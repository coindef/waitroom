# Changelog

## Unreleased

### wait-ship 0.1.7

- **The shared row is one row again on Claude Code 2.1.323 and later.** Those versions ask every mod for its own row and stack the answers, and `next()` no longer says who drew. wait-ship leaves the other rows out of `AbovePromptList`, in the same order as before: breathe, then this offer, then the bet. While a turn runs, the bet's forecast comes before this offer, and a breathe nudge still comes first. On 2.1.319 and earlier it still yields from the stamp on `next()`.

### wait-secret 0.1.2

- **The card yields the shared row on Claude Code 2.1.323 and later.** wait-secret waits behind breathe, ship, the bet, and scope, and shows once they close. On 2.1.319 and earlier the stamp on `next()` still decides.

### wait-scope 0.1.2

- **The card yields the shared row again on Claude Code 2.1.323 and later.** wait-scope was stacking on a wait-ship offer. It waits behind breathe, ship, and the bet, and shows once they close. On 2.1.319 and earlier the stamp on `next()` still decides.

### wait-breathe 0.2.2

- **The shared row is one row again on Claude Code 2.1.323 and later.** A due breathe nudge keeps the row ahead of a ship offer and a forecast instead of stacking on them. On 2.1.319 and earlier a nudge still takes the row by drawing it.

### wait-focus 0.1.1

- **wait-focus has an icon.** `plugin.json` points at `.claude-plugin/icon.png`, so `claude plugin validate` no longer warns that it is missing.

### wait-anchor 0.1.2

- **wait-anchor has an icon.** `plugin.json` points at `.claude-plugin/icon.png`, so `claude plugin validate` no longer warns that it is missing.

### bet-on-your-agent 0.6.6

- **The shared row is one row again on Claude Code 2.1.323 and later.** The bet's forecast still comes ahead of a ship offer while a turn runs, and still waits behind a breathe nudge and, between turns, a ship offer. The yield is done by leaving the other rows out of `AbovePromptList`. On 2.1.319 and earlier the stamp on `next()` still decides.
- **A turn that could not be saved says so.** When the history cannot be read, one line: `couldn't save that turn`. A save that fails shows the same line. The status line still goes blank.
- **A failed read keeps the record on screen.** The pane, the recap and the row keep the last history that loaded, instead of looking like the rank and the score were wiped.
- **A failed read of the daily challenges leaves them in place.** Today's result is not written over the streak.
- **A store file that can't be read is rebuilt.** A 0-byte store file is treated as empty. A file that is not JSON, JSON that is not an object, or whose saved turns are not a list, is copied to `<store>.bak` and rebuilt, and the next `/bet` says `couldn't read the saved history · rebuilt`. A later repair keeps the first backup and writes `<store>.bak-<ms>`. The repair leaves the engine's lock alone and waits for a later turn while the lock is held.
- **A history that is not a list is not written over.** When the store can't be repaired, the turn that just ended does not replace it, and that is noted once: `couldn't read the saved history`.
- **A local-directory marketplace install is not repaired.** See *Known limits* in the plugin README.

### wait-ship 0.1.6

- **A new file no longer calls an edit in the same directory an add.** The new file is added and the edit is updated, and only the new file is listed under Added. A deleted file is its own Removes line, not a restructure, and it is not listed twice. An edit that deletes more lines than it adds stays an update. The commit subject names each path when there are at most three files and the line fits in 72 characters. Otherwise it counts, as in `add 2 files, update 1 file`.

### wait-ship 0.1.5

- **A file whose name git quotes stays in the kit.** An untracked `café.txt` or `a "quoted" name.txt` was dropped, and a tracked non-ASCII name was written with octal escapes. The scan reads the name as it is on disk. A control character or a bidi mark in that name is written as a visible escape (`\x1b`, `\n`, `\u202e`), not as the raw character.
- **A file git could not read is counted.** The row says `1 file skipped: git couldn't read it` (or `2 files skipped: git couldn't read them`). The kit still lists only the files it read.

### wait-secret 0.1.1

- **A diff git could not read is not treated as an empty tree.** If that read fails, secrets that were already staged are not reported as this turn's, and the failed read is not saved as the baseline. A repository with no commit yet is diffed against the empty tree, so a staged secret is still seen.
- **A long list of new files does not stall the turn.** The scan reads at most 100 new files. If there are more, it stops and says so (`scanned 100 of 101 new files`) instead of looking finished, and it does not open the rest.
- **A diff that was cut off is not a clean result.** When the diff is too big to read in full, the status line says `diff too big · /wait-secret turns it off`. The partial text is not listed and is not saved as the baseline.
- **Committing the secret no longer hides it.** The scan also reads what was committed during the turn. If that range cannot be read, the turn is not reported as clean.

### wait-ship 0.1.4

- **An edit you make between turns is not drafted as the next turn's work.** wait-ship reads the tree again when a turn starts, so the kit names only the files that turn changed, and a turn that changed nothing stays quiet. If that read fails, the turn still starts and the kit compares against the last read that worked. If the read takes too long, wait-ship can't tell what was there before, so it still offers a kit instead of hiding one. What an older version saved still works after you update.

### bet-on-your-agent 0.6.5

- **A file git is slow to read is not counted as written.** If a hash does not come back, that path stays as it was. It does not show up as a file this turn wrote.
- **One path git cannot hash no longer pauses on every other file.** The rest of the turn's files are still counted.
- **Five hundred changed paths still count as five hundred.** The running total was cut off at 200. More than 500 paths in `git status` is still not a count.

### wait-ping 0.1.2

- **From an hour, the away line drops the seconds.** `1h 0m 40s` is `1h`. `2h 1m 40s` is `2h 1m`. Under an hour is unchanged (`45s`, `1m`, `1m 30s`, `59m 59s`).
- **An unusable threshold is named when you turn notifications on.** `(0.5 isn't usable, using 30s)`. A value that floors to at least 1 is kept and is not named.

### wait-scope 0.1.1

- **A scope file that can't be read is not "no scope".** If `.claude/wait-scope` is there but the read fails, the turn keeps the last scope that file gave, or skips the check, and says so once. It does not guess, and it does not use the setting in place of that file.
- **`*` is the top level only, and `src/*` is the files directly in that folder.** A bare folder name still covers everything inside it.
- **A comma in `.claude/wait-scope` stays in the glob.** `src/**/*.{ts,tsx}` matches `.ts` and `.tsx`. Commas still separate globs in the *Files in scope* setting.
- **A glob typed in the prompt is read like an edited path.** `..`, the macOS `/private` alias, and a drive letter fold the same way. A guess does not cover a file outside the project.
- **`fix src/auth` is a folder.** `and/or`, `read/write`, and `TCP/IP` stay prose.

### wait-breathe 0.2.1

- **If the cooldown cannot be read, no nudge is shown, and what is already saved is left alone.** Once the read works again, nudges come back on their usual ten-minute schedule. If the saved record itself cannot be read, the next due nudge starts a fresh one, so one bad value cannot turn the nudges off for good.

### wait-cards 0.1.1

- **A comment in the deck only hides cards when it is its own block.** A `<!--` written on a question or an answer stays. An unclosed comment hides the cards under it, and `/card` counts them as skipped.
- **A card waits out its box.** When nothing is due, the line stays clear. `/card got` on a card that was not due does not move it up, so the waits in the reply are the waits until it comes back: 2, 4, 8, then 16.
- **A failed read leaves the boxes alone.** If the saved progress can't be read, that wait writes nothing, and `/card` says `couldn't read your progress · nothing was changed · try /card again`. A saved count of waits that isn't a real number continues from the cards, so the line does not stay clear for the old count. A saved card that isn't a real record is replaced once. A card with no saved record still starts at box 1.
- **Showing a card keeps a mark from another session.** That wait updates when the card was shown. The box and the due wait stay as the later read has them.
- **`/card` says when the deck was cut.** A deck keeps 1000 cards from the first 256 KiB. Past that, the reply says `1000 of 1001 cards · deck capped at 1000` or `deck cut at 256 KiB`.

### wait-focus 0.1.0

First release: you name one to three paths, and after a turn the status line says whether the turn touched each one.

- **`/wait-focus src/auth/ package.json`.** One, two, or three files or folders. Replaces the list. A fourth path is refused (`3 paths max · name one to three, like src/auth/ or package.json`) and the list you had stays. A path outside the project is refused and the list stays. A glob (`src/**/*.ts`, `src/auth/*`) is refused (`src/**/*.ts looks like a glob · name a file or folder, like src/auth/ or package.json`) and the list stays. A path that is not on disk yet is still watched. `/wait-focus` shows the list. `/wait-focus clear` clears it. The command is `/wait-focus`, because `/focus` is already a Claude Code command. The reply does not start a turn.
- **Status line.** After a main-loop turn, `src/auth/ touched · package.json untouched`. A folder is touched when anything under it changed, including a rename or a delete. The line comes down while the next turn runs. Past 48 columns, folders are shortened from the left (`…/LoginForm.tsx touched · package.json untouched`). If that is still too wide, the words become `yes` and `no` (`…/auth/ yes · package.json no · README.md no`). No list, no line. It does not take the row above the prompt.
- **Read-only git.** `diff --name-status`, `ls-files`, and `hash-object`, from the project directory. A file that was already dirty counts when its contents change. A gitignored file is not counted. Each call gives up after 3 seconds. The start of a turn waits on those calls. The answer is sent before the end reads.
- **A commit during the turn counts.** The turn records HEAD when it starts. If HEAD moved, `git diff <start> HEAD -- <paths>` is added to the work-tree diff. An edit that is committed, a new file, several commits, an amend, a reset, or a rebase all count: the work tree matches the new HEAD, and only that range diff shows the path. If that diff cannot be read, the line stays blank. It does not say untouched.
- **A symlink or a submodule** on the list says `is a symlink` or `is a submodule`, instead of a blank line.
- **Fails open.** Outside a git repository, or when git fails, times out, or its output is cut off, the turn stays quiet: no line, no crash, and no guess. More than 40 changed files under the list does the same. Nothing is blocked, edited, or committed. A slow end read does not paint the previous turn's line over the next turn.
- **Kept in `$.store`.** One value, keyed by the project root, under Claude's configuration directory. Two sessions in one project share it. A missing project root saves nothing.

### bet-on-your-agent-opencode 0.0.1

- **Digits type into the prompt.** A digit answers the bet only when the bet row has focus. While the prompt has focus, every key, including a digit, stays in the prompt. Skip is labeled `0: Skip` on the confidence, file, bonus, and verdict rows.
- **A retry does not close the bet.** The turn ends when the session goes idle.
- **History waits for the file.** A turn that ends before `api.kv` has read `kv.json` is held and then merged into that file. It does not replace other plugins' keys.
- **The file forecast counts a turn that wrote files another way.** `session.diff`, `apply_patch` text, a `patch` message part, and, when the diff call is missing, `git status`. A tool part that errors counts once, the same as one that completes.
- **The band repaints.** The open bet and the rank-up line live in a Solid store the slot reads while it renders.

### wait-notify 0.1.1

- **The reminder waits for your answer.** A quick Read or a subagent's tool finishing alongside the one you're answering no longer cancels it.
- **A session you ended stays ended.** A prompt sent right as you exit or `/clear` no longer makes other sessions think it's still open.

### wait-anchor 0.1.1

- **A turn ending no longer brings back an older note.** If you clear or replace the note while a turn is ending, your change stays.
- **If your note can't be read, it's left alone.** The status line says so, and nothing is changed or cleared. `/anchor` says nothing was changed. A new note says it wasn't saved. `/anchor clear` says nothing was cleared.

### bet-on-your-agent 0.6.4

- **A subagent's tool calls stay off the turn's tool-call count.** A `tool.call` that carries an `agentId` does not increment that count. `Edit`, `Write`, and `NotebookEdit` still add the path they name to "N written so far" when the call is not denied and not an error. `Bash` still reads the working tree.
- **`/bet-recap` counts this session.** "This session" is the turns stamped with the current session id. A turn another window recorded, even one made after this session began, stays out of the card. The rank and the badge wall still read the whole history. With no session id from the host, the card falls back to the turns since this session started.

### bet-on-your-agent 0.6.3

- **A file count that cannot be read is not scored as none.** When a snapshot was taken and a later `git status` lists more than 500 paths (changed or untracked, not only this turn's), the row says the count is unknown and that question is left out of the score. A tree already past that limit when the turn starts has no snapshot, so the count is the `Edit`, `Write` and `NotebookEdit` calls, the same as outside a repository. One path git cannot hash is skipped on its own, so the rest of the turn's files still count.

### bet-on-your-agent 0.6.2

- **A failed read of the history no longer replaces it.** One error reading
  the stored turns was treated as an empty history, and the turn that just
  ended was written over every record. That turn is left unrecorded, and the
  status line is cleared instead of staying on the running-turn prompt.

### wait-ship 0.1.3

- **Every path in the transcript receipt follows the folder the session is
  in now.** From a subfolder that is the path after `Draft written:` and the
  same path in `git commit -F`, `gh pr create --body-file`, and the changelog
  paste line. Each command's path is one single-quoted word. A later `/cd`
  or worktree, or a space in the drafts folder, no longer makes the command
  miss the file. An absolute `shipDir` is still written under the repository,
  and the receipt names that file.

### waitroom 0.1.2

- **If you already have waitroom installed, update it.** Version 0.1.1 still asked for `wait-review` after that plugin left the catalog, so the bundle failed to load with `Dependency "wait-review@waitroom" is not installed`. This release is 0.1.2, so the update actually runs. Run `claude plugin marketplace update waitroom`, then `claude plugin update waitroom@waitroom`. You should see `Plugin "waitroom" updated from 0.1.1 to 0.1.2 for scope user. Restart to apply changes.` Restart once. After that, waitroom loads again and keeps bet-on-your-agent, wait-ship, and wait-breathe.

- **Three old plugins are now disabled, and that is expected.** `wait-review`, `wait-changed`, and `wait-shell` are no longer in the catalog. After the update they stay installed locally and show as disabled (or "Removed from the waitroom marketplace"). While they are still installed, `claude plugin prune` refuses to run. Uninstall those three first. You don't need to install anything in their place.

### wait-cards 0.1.0

First release: one flashcard from a deck you write, one card per wait.

- **Deck.** `~/.waitroom/cards.md`, a `Q:` line and then an `A:` line per card. This mod reads the file and never writes it. It does not make cards for you.
- **While Claude works.** The status line shows `Q: ` and the question. Past 48 columns it ends in `…`, on a character boundary.
- **When the turn ends.** One log line, `A: 429 · /card got or /card miss`. It is shown to you, not sent to Claude. An interrupted turn gets its answer too. A subagent's turn does not count.
- **`/card got` and `/card miss`.** Optional. `got` moves the card up one of five boxes, `miss` sends it back to box 1, and a missed card comes back on the next wait. A card you don't mark keeps its box. `/card` counts the deck.
- **No deck.** One log line, `Add cards to ~/.waitroom/cards.md`, and then quiet. No sample cards.
- **Kept in `$.store`.** Each card's box and a count of waits, under Claude's configuration directory. No model, no network, no keypress capture.

### wait-anchor 0.1.0

First release: a note you set for yourself, the goal and what to check when you come back.

- **`/anchor`.** `ship login fix · check: redirect works` sets or replaces the note. `/anchor` shows it. `/anchor clear` clears it. With no note, the reply is `/anchor what you're doing · check: what to verify`. The reply does not start a turn.
- **Status line.** `⚓ ship login fix → redirect works`. The check words stay as written. Past 48 columns the line ends in `…`. Claude Code chooses where that line sits among the other mods' lines. No note, no line. It does not take the row above the prompt.
- **After Stop.** The next prompt you type logs `Back? You said: redirect works.` once. The prompt is unchanged. A later prompt does not repeat it until another main-loop turn ends.
- **Kept as plugin-scoped JSON** under Claude's configuration directory. One value per project root and session id. Stop does not clear it. `/anchor clear` does. This mod does not choose the file name. A missing session id or project root saves nothing.
- **No transcript reads.** The note never comes from your transcript. The Back? line is shown to you, not sent to the model. No summary, no model, no network. The note is stored as text.
- If the note can't be saved, the Back? line waits for your next prompt.

### wait-notify 0.1.0

First release: a native macOS notification when Claude Code is blocked on you and you're not at the terminal. One reminder after 3 minutes, then quiet.

- **Two moments, from Claude Code's `Notification` hook.** `permission_prompt` says `Waiting on a permission`. Claude asking you a question says `Asked you a question`: the `AskUserQuestion` dialog (Claude Code sends `permission_prompt` for it too, so an open `AskUserQuestion` call tells them apart) or an MCP server's `elicitation_dialog`. Titled `Claude needs you · <project folder>`. When two live sessions' folders have the same name, each title adds its parent folder's name (`work/api`, `fork/api`), or a short session-id tag (`api · 3f2a`) when the parent folders' names match too. Never more of the path than those two names. With no session id or project root from Claude Code, the title is the plain `Claude needs you`. `idle_prompt` and every other type send nothing.
- **Only when you're away.** Present means `HIDIdleTime` from `ioreg -c IOHIDSystem` under 30 seconds, with Terminal, iTerm2, Ghostty, VS Code or Cursor frontmost (`osascript`). Present sends nothing, now or later.
- **One reminder.** After 3 minutes, if Claude is still blocked and you're still away: `Still waiting · 3 min`. Never a second. Your prompt, the waiting tool call finishing, the main turn ending, an answered MCP question or the session ending cancels it. So does being back at the terminal by the recheck, which counts any key or mouse event since the notification, as long as a terminal is in front at the recheck. Claude Code raises no event when you answer a permission dialog, but your answer is a key press at the terminal. So if you allow a long command and walk away, no reminder comes while it runs. An answer from your phone or the web can still get one, and so can an answer followed by a switch to another app.
- **A turn end is silent** unless `notify_on_stop` is on.
- **`~/.waitroom/notify.json`:** `present_idle_secs` (30), `remind_after_min` (3), `notify_on_stop` (false). A missing or broken file means the defaults.
- **macOS only.** Anything but `Darwin` from `uname`, and nothing else runs. No shell, no network, no sound. It never blocks or changes a tool call or a prompt.

### wait-shell 0.1.0

First release: while a turn runs, lists the shell commands it ran. wait-changed shows the files a turn changed; wait-shell shows the commands it ran.

- **Every Bash call in the turn.** Claude's and its subagents', in the order they finish. A call a hook refused never ran, so the list leaves it out. `error`, `stopped` and `background` mark a command that did not simply finish.
- **Status line.** `N shell command(s)` while the turn runs, and after it until `Close` or the next turn. Hidden at 0.
- **The row.** `$ git status`, one command per row, newest last: line breaks shown as `↵`, cut at 200 characters, up to eight rows under `N earlier commands…`. Last in the shared row.
- **Only a list.** Never blocks, rewrites or reruns a command, and runs nothing of its own. No network, no telemetry. `Close` puts it away for the turn; `Don't show again` and `/wait-shell` turn it off and on.

## wait-secret 0.1.0

First release: after a turn ends, flags lines it wrote that look like a key or token. wait-changed shows what changed this turn; wait-secret shows what in it looks like a secret.

- **Only this turn's lines.** Lines added against HEAD (tracked and untracked), minus those already uncommitted when the turn started. Read with the same local `git diff` wait-changed uses.
- **Eight patterns.** `sk-ant-`, `sk-`, `AKIA`, `ghp_`/`github_pat_`, `xoxb-`, private key headers, `.env` `KEY=value`, and `api_key=`-style assignments with a random-looking value.
- **Status line.** `N possible secret(s)` once the turn ends, never the kind. Hidden at 0.
- **Turn end.** The row lists `path:line  sk-…3f9a  (OpenAI key?)`: prefix and last four only. Up to eight, then `N more…`.
- **Ignore.** `# wait-secret: ignore` or `// wait-secret: ignore` on the line.
- **Only warns.** Never blocks, never edits a file, no network, no telemetry. `/wait-secret` turns it off and on.

## wait-scope 0.1.0

First release: warns when a Claude Code turn edits files outside the scope you set. wait-changed shows what changed this turn; wait-scope shows what changed outside what you asked for.

- **Scope.** Globs in `.claude/wait-scope` (one per line, `#` comments), or the comma-separated *Files in scope* setting. The file wins. These are authoritative.
- **Status line.** After each landed Edit, Write, MultiEdit or NotebookEdit, `N outside scope` — only for files outside your globs. Hidden at 0 and when no scope is set.
- **Turn end.** The row lists the files outside the scope (up to eight, then `N more files…`). With no scope, files outside the paths your prompt named are listed as `(guess)` and never counted.
- **Only warns.** Never blocks, never reverts, no network, no telemetry. `/wait-scope` turns it off and on.

## wait-ping 0.1.1

- **A threshold under a second stays at 30.** A value between 0 and 1 used
  to floor to 0, and then every turn notified, including a turn of 0 ms
  (`You were away 0s`). It floors, then keeps the number only when it is at
  least 1. The setting's minimum is 1.
- **A long turn names the hours.** `You were away 2h`, `You were away 1h 5m`,
  or `You were away 2h 1m 40s`. Under an hour the line is unchanged (`45s`,
  `1m`, `1m 30s`).

## wait-ping 0.1.0

First release: a local OS notification when a Claude Code turn ends, or when a permission confirm is waiting.

- **Stop.** When a main-loop turn ends after at least `thresholdSeconds` (30 by default), one notification titled `Waitroom`: `You were away 45s`, `You were away 1m`, or `You were away 1m 30s`. That time is how long the turn ran. A shorter turn, a turn you interrupted, and a subagent's turn stay quiet.
- **Permission.** Claude Code's Notification hook, type `permission_prompt`, notifies even if the turn is still under the threshold: `Needs your OK`. Other notification types do not.
- **Sound off unless you turn it on.** macOS runs `osascript` (and adds `sound name "Ping"` only when sound is on). Linux runs `notify-send` (and adds a sound hint only when sound is on).
- **No network.** `uname` chooses the desktop. Then `osascript` or `notify-send` runs, and nothing else. "You were away" is the turn's own clock, not a separate tracker.

## wait-review 0.4.3

- **One quiet tip the first time Claude's Diff covers the pane.** The first turn that writes a diff while focus never lands logs `Claude's Diff is covering Waitroom. Send /diff once to show wait-review — Claude remembers.` Once, then not again. It does not close Claude's panel.

## waitroom 0.1.1

- **One quiet tip on the first session.** After `waitroom@waitroom` loads, the first interactive session logs three lines in the transcript: the four rooms are in, wait-breathe stays off until `/breathe`, and the optional `claude plugin install wait-changed@waitroom`. It does not return. No pane and no row.

## waitroom 0.1.0

- **One install for the four rooms.** `claude plugin marketplace add coindef/waitroom && claude plugin install waitroom@waitroom` installs wait-review, bet-on-your-agent, wait-ship, and wait-breathe. Each room still installs on its own. wait-changed stays a separate install. wait-breathe stays off until `/breathe`.
- **Optional wait-changed is named under that one-liner.** `claude plugin install wait-changed@waitroom` lists the files a turn changed. It is not in the four-room install.

## wait-changed 0.1.0

First release: a read-only card once a Claude Code turn ends.

- **`What changed this turn`.** Filenames and a one-line hint (`+12 −3`, or
  `added` / `deleted` / `modified` when there is no line count), at most
  eight files, then `N more files…`. Subtitle `Read-only local git — nothing
  uploaded`. No hunks.
- **Only after the turn, and only when this turn changed files.** A clean
  tree, dirt that was already there, a turn still running, and a folder that
  is not a git repository all stay silent. A failed `git` read stays silent
  too.
- **Two actions.** `Close` dismisses this turn's card. `Don't show again` turns the
  card off. `/wait-changed` turns it back on, and so does *Show a turn-end
  diff card* under `/plugin` → wait-changed.
- **The shared row, under the transcript.** It does not cover Claude's reply.
  Between turns it comes ahead of a wait-ship offer and bet-on-your-agent's
  "Did it land?"; `Close` is what gives them the row. It is not drawn while a
  turn runs.

## wait-ship 0.1.2

- **The shared row yields to wait-changed between turns** when that mod is
  installed and showing its card. While a turn runs, nothing here changes.

## bet-on-your-agent 0.6.1

- **Between turns, the row yields to a wait-changed card** ahead of a ship
  offer. While a turn runs, only a breathe nudge still holds the forecast
  back.

## wait-review 0.4.2

- **A first-run line when the pane opens by itself.** It does not take the
  keys, so the first time it is up without them it says, in bold, `Focus this
  pane: /wait-review · then o / f work`. That line shows once: it is gone for
  good after `/wait-review`, or after `o` or `f` while the pane holds the keys.
  Opening by itself still leaves the keys with the prompt. `/wait-review`
  still takes them.
- **A narrow terminal says so, and one command opens the pane anyway.** Under
  144 columns the status line reads `3 to read · terminal too narrow —
  /wait-review opens anyway`. `/wait-review` places the pane at any width and
  now runs while a turn is still going, which is when that line is on screen.
- **Claude's own diff panel.** When `/wait-review` asks for the keys and they
  never arrive, its reply says `Claude’s /diff is covering this side — send
  /diff once to show wait-review`.

## bet-on-your-agent 0.6.0

- **The badge wall moved into `/bet`'s own report**, not just `/bet-recap`.
  Same six badges, shown or locked, now beside the record every time you ask.

## wait-breathe 0.2.0

- **`/breathe`**, a status command: whether the nudges are on, the threshold
  either way, and exactly where to flip it in `/plugin`. The one place to
  find this mod again once its install screen has scrolled past — there was
  no pane and no band entry to stumble into otherwise.

## wait-ship 0.1.1

- **The band tag moved off the `suggestion` token it shared with
  `wait-review`'s bar onto its own `success` green**, matching the color
  `docs/paging.svg` already used for it.
- The README's first-minute walkthrough now shows the ship-offer row inline
  (`docs/ship-offer.svg`) and says the bare-letter answer needs no focus, the
  same way `bet-on-your-agent`'s digits don't.
- Test count in the README corrected to 53.

## wait-review 0.4.1

- **The progress bar's rule changed from `━` to `─`**, matching the weight of
  the hunk separator below it, so the two read as one family of rule with
  color carrying the progress instead of a second line weight.
- Test count in the README corrected to 78.

## Icons and docs, across all four mods

- **Every `.claude-plugin/icon.svg` unified to the same 24px stroke-width
  baseline.** `bet-on-your-agent`'s target is now two stroked rings and a
  filled center dot, in place of four solid alternating discs that read as a
  single blob at small sizes; `wait-breathe`'s three rings now share
  stroke-width 24 with an opacity floor of 0.6/0.8/1.0, in place of
  14/16/20px strokes at 0.35/0.6/1, which closed up into one ring under 32px.
- **`docs/lockup.svg`**, all four icons side by side, now sits near the top
  of the root README; **`docs/ship-offer.svg`** and **`docs/breathe-nudge.svg`**
  show each mod's row inline the same way `docs/paging.svg` already did for
  the others.
- The root README's first-minute walkthrough now covers `wait-ship` and
  `wait-breathe` the same way it already covered `wait-review` and
  `bet-on-your-agent`, gained a `userConfig` conventions section
  (`autoOpen` vs `enabled`), and unified scattered copy across the "What they
  are" table and "The idea behind" section to read as four mods rather than
  two-plus-two.

## 0.1.0 — wait-ship and wait-breathe

Two new mods, each starting its own version from here.

### wait-ship

First release: drafts the words around a turn's changes, the moment it ends.

- **A commit message, a PR description, and — where `CHANGELOG.md` exists — a
  changelog entry**, drafted from the diff alone: no model call, the same
  deterministic pass every time on the same input.
- **Matches the repository's own voice.** The last 20 commit subjects decide
  whether the drafted subject is a conventional commit or freeform, and if
  freeform, which capitalization and tense it follows; a changelog entry
  matches the file's own bold-lead-in or plain bullet style.
- **Each area of the diff reads its own kind of change** — a new file, an
  edit, a deletion, tests-only, docs-only — so the PR summary and changelog
  bullets say what actually happened in that area rather than the one kind
  the whole diff happens to read as.
- **Lives in the row above the prompt**, the same one `bet-on-your-agent`
  uses: accept every draft, just one, or drafts framed for editing, or skip.
  Accepted drafts are written under `shipDir` (`.waitroom/ship` by default)
  and the row prints the exact command to run — `git commit -F`, `gh pr
  create --body-file`, or where to paste the changelog entry. Nothing is ever
  run on your behalf.
- **No changes, no row** — same as `wait-review` with nothing to show.

### wait-breathe

First release: a gentle, deterministic nudge to take care of yourself during
a long turn. Off by default.

- **One quiet line** in the row above the prompt once a single turn runs past
  `longTurnSeconds` (90 by default): a posture check, a 20-20-20 eye break,
  4-4-4 breathing, or a stretch, rotating so it is never the same one twice
  running. Naming the action only — no health claim, no "you should."
- **At most one line per turn, and at most one every ten minutes**, however
  many turns run long in between.
- **Zero required keys.** `Took it` only exists so the count means something;
  nothing here ever blocks a turn or needs an answer.
- **Yields to a real survey** already asking something else, the same
  convention every mod in this marketplace follows.
- **A session-end summary line** — `breathe: 3 prompts, 2 taken this
  session` — said only once at least one nudge actually showed.

## 0.5.0 — playability, phase 2

### bet-on-your-agent

- **A badge wall.** Six badges sit beside the record, always shown whether
  earned or locked: First Steps, Hot Streak (5 landed calls running),
  Sharpshooter (ten straight scored calls under a 0.20 Brier), Oracle Path
  (reaching the top rank once, lifetime), Bonus Hunter (five bonus questions
  right), and Regular (five distinct days with a scored bet). `/bet-recap`
  carries the same wall.
- **A daily challenge.** Once a day, one optional yes/no question — will this
  turn beat your own median on whichever dimension the date picks — scored
  the moment the turn lands, no verdict needed. A run of right days shows in
  `/bet-recap`'s "Daily challenge" row once it reaches two.

### bet-on-your-agent-opencode

- **The rotating bonus question and calibration ranks**, synced with the
  Claude Code mod: same dimensions, buckets and wording, same rank cutoffs,
  the same "Rank up: Silver → Gold" line shown once beside the post-turn
  record. `/bet-recap` and the badge wall are not ported this round.

### Fixes

- **The daily challenge no longer re-asks itself.** A turn that ended with
  the challenge still on screen — offered, but never answered or declined —
  left no record for the day, so the next turn repeated the identical
  question. It is now recorded as "not taken": not scored, and costing
  nothing either way on the streak, and `/bet-recap` reads it apart from a
  day with no turns at all, which still reads a plain em dash.
- **The OpenCode band reads "1 file", not "1 files".** The file-count bucket
  printed its raw label with a bare "files" suffix; it now reads through the
  same pluralization the Claude Code mod already uses.
- **The daily challenge stops claiming a personal median it isn't using.**
  Under five scored turns the question is judged against a fixed fallback,
  not your own median — the wording now says so ("…than a typical turn?")
  instead of asking about "your median" before there is one.

## 0.4.0 — playability, phase 1

### bet-on-your-agent

- **A bonus question beyond land/fail.** Once the duration and files bets are
  answered, one more optional question rotates in — turn duration, file
  count, or tool-call count, one dimension per turn, cycling through all
  three over a session. Same `skip`, costing nothing.
- **Rank, from your rolling calibration.** The record now carries a rank —
  `Coin-Flipper` through `Oracle`, or `Unranked` under five scored turns —
  from the Brier score over your last 20 scored turns rather than the
  lifetime one, so it reflects how you are calling it lately. Climbing a
  level prints one line once: `Rank up: Silver -> Gold`.
- **`/bet-recap`**: a shareable, plain-text recap card for the session —
  turns bet and scored, session Brier, best and worst call, rank, current
  streak, and the bonus tally.

### wait-review

- **Combo and session grade.** Deciding hunks back-to-back without an
  intervening skip builds a combo, shown as `combo x5` once it reaches
  three; skipping a file breaks it back to nothing. The session grades how
  much of what was resolved was actually read rather than waved away in
  bulk: `S` needs at least 90% read and one flag, `A` 75%, `B` 50%, else
  `C`. Both show in the pane and in `/wait-review`'s reply, and an undo
  reverses them along with the hunk.

## wait-review 0.3.1

- **No false "diff panel is in front".** `/wait-review` decided the pane was
  covered when the focus it asked for had not arrived yet — and focus lands
  100–400ms after the pane opens (seen live on 2.1.304), so the warning showed
  beside a pane that was plainly on screen. It now gives focus up to 600ms
  before saying so. Checked live both ways: three tries with the pane in view
  say only `Review pane open.`; with the diff panel up, the warning still shows.

## 0.3.0 — a design pass, from the user's seat

Both mods, after reviewing every state each one draws in a live session.

### wait-review

- **One header instead of three counters.** "2 to read", "file 1 of 2" and
  "2 left" said nearly the same thing three ways. The header now carries the
  pane's name, a bar that fills as you read, and the counts.
- **`path:line` with colored `+`/`−` counts** on one row, in place of
  `line 1 · +17 −4` under the path.
- **You can see where the keys are.** The controls are dim until the pane holds
  the keyboard; then `Looks right` is green, `Flag` amber, and the hint reads
  `● esc hands the keys back to the prompt`.
- **The flag is a callout**, an amber bar under the controls: how many are
  flagged, that they go to Claude with your next message, and `n: Say why`.
- **The note box reads as a field.** `Why flag src/client.ts:1?` over an amber
  frame with an example in it, and a hint for Enter, in place of
  `Why is this wrong?:Enter on an empty box if the diff says…`.
- **`✓ All caught up`** when the diff is read, with what was read and whether
  anything goes to Claude, in place of a dim "Diff read".
- **One empty state**, with the keys drawn as keys, in place of "nothing to
  read" twice.

### bet-on-your-agent

- **The row says whose it is**: an orange `bet` tag on every question.
- **The file answers can no longer be misread.** `1: 0  2: 1  3: 2-3` put "one
  file" on the 2 key; they are now `1: none  2: one  3: 2–3  4: 4+`.
- **"Did it land?" leads its line**, so a narrow row cuts the quoted ask, not
  the question (it used to end `Did it…`). `Landed` is green, `Needed fixing`
  amber, and so is the result once recorded.
- **No verdict before there is a sample.** Under five scored calls the
  headline, the status line and `/bet` say `Calibrating ●●○○○ 2 of 5 calls`
  instead of "You run 80 points overconfident" off two turns.
- **`/bet` reads cleaner**: its own tag, worst calls on one line each with
  repeats folded into `×2`, the table dim while calibrating.

## wait-review 0.2.3

- **The note box shows the hunk it asks about.** `f` moves the card on to the
  next hunk, so `n` opened "Why is this wrong?" over an empty pane, and the
  reason was typed for code no longer on screen. Found while recording the
  demo. The box now draws the flagged hunk under it, sized to the pane and
  starting from the page you were reading when you flagged it.

## wait-review 0.2.2

- **The pane's key hint names the way in that always works.** While a row
  above the prompt has buttons up — bet-on-your-agent asking "Did it land?" —
  `ctrl+x tab` gives the keys to that row, not to this pane, so the pane's
  `ctrl+x tab to use these keys` sent its letters into the prompt. Found while
  recording the demo, and checked live: two presses of `ctrl+x tab` never reach
  the pane while the row asks, and `/wait-review` does. The hint now reads
  `/wait-review or ctrl+x tab to use these keys · or click them`, and the pane
  counts the extra row when that wraps.

## wait-review 0.2.1

- **Works beside Claude Code's new diff panel.** Claude Code 2.1.304 (now the
  stable release) opens a diff panel of its own beside the transcript when
  Claude edits, in front of this pane — found while recording the demo, where
  the review keys went into the prompt instead. `/diff` hides it, and Claude
  Code remembers that across sessions (checked live). The README says so
  where the pane is introduced, and `/wait-review`, which used to answer
  `Review pane open.` with the pane out of sight, now says the diff panel is
  in front and that `/diff` hides it. It tells by the keyboard focus it asks
  for not arriving: the pane list Claude Code hands plugins still calls the
  pane shown while it is covered.

## bet-on-your-agent 0.2.3

- **Files written through the shell count.** The file forecast was resolved
  from `Edit`, `Write` and `NotebookEdit` calls only. Found while recording the
  demo: Claude wrote two files with one `cat > … <<'EOF'` command, and the
  band read `0 written so far` all turn — so the files bet would have been
  scored as 0. In a git repository it now compares what git sees changed
  before the turn with after each shell command and at the end, and counts
  every file whose content moved, alongside the tool calls. Outside a
  repository nothing changes.

## bet-on-your-agent 0.2.2

- **The turn that just landed is the one asked about.** With more than one
  verdict owed, the band asked about the oldest. Found in a live session: bet
  on a turn, watch it land, and the band asked about one from forty minutes
  earlier instead. It now asks about the latest, and the older ones wait
  behind it until they lapse.

## bet-on-your-agent 0.2.1

- **A bet left unanswered lapses after four hours.** "Did it land?" waited for
  an answer forever, so a bet left at the end of a day opened the next day's
  session by asking about a turn nobody remembered — and a session restart is
  what every `/plugin update` asks for. Past the window the bet is waved away
  as a skip would: still on the record, never scored, never asked about.

`wait-review` is unchanged at 0.2.0.

## 0.2.0 — launch

Both mods are bumped together, so `/plugin update` brings an install from
0.1.0 onto this: the installed copy is kept per version, and an unchanged
version keeps the old code even when the repository has moved on.

### wait-review

- **Long hunks page instead of being cut off.** A new file is a single hunk as
  long as the file, so it could never be read past the first screen. `j` reads
  on, `k` reads back, and the pane says `lines 31–60 of 200`. Every page is a
  valid hunk of its own, so it still draws as a diff.
- **Long changed lines wrap instead of being cut at the pane's edge.** Found
  in a live session: the pane showed `AbortSignal.timeout(10_0…` and hid
  exactly the change being reviewed. Pages are measured in rows, so a run of
  long lines does not push the controls off the screen.
- **Pages fit the pane, not the terminal.** Pages were sized to the whole
  terminal, but the prompt and status rows sit below the pane, so a long
  hunk's first page ran off the bottom and took the controls with it.
- **The pane says how to give it the keys.** Its letters only work while it
  holds the keyboard, and pressing `o` without that types an `o` into your
  prompt. Unfocused it now says `ctrl+x tab to use these keys · or click them`;
  focused, `esc hands the keys back to the prompt`.
- **Reads git, not edit tools.** An agent that writes through a shell heredoc
  makes no Edit call, so nothing used to be queued for it. The scan now reads
  the repository diff, however a file came to be written.
- **A commit no longer empties the queue.** The diff is anchored to where the
  session started, since an agent commits on your behalf, often before you have
  read a line, and a commit is not a review.
- **Your own work in progress is left out.** What was already uncommitted when
  the session started is not offered as the agent's review.
- **Say why** when you flag: `n` opens a box, and the reason travels to Claude
  with the hunk.
- **Undo** with `u`; **skip a whole file** with `x`, counted as skipped rather
  than read — and skipping a file is undoable too, each hunk going back to the
  status it actually had rather than a blanket reset.
- **`/wait-review` opens the pane holding the keyboard**, so its letters answer
  at once. The pane that opens by itself at session start deliberately does
  not, since it would eat the first keystrokes of an unsent prompt.
- **The status line keeps reminding you of hunks put off**, rather than going
  quiet once nothing is pending — which is exactly when `later` needs to be
  remembered.
- **Lockfiles, build output and snapshots are never queued**; `ignore` replaces
  the list.
- The empty pane teaches the keys before you need them, and the status line
  reads `3 to read · open with /wait-review` when the pane has not been placed.

### bet-on-your-agent

- **The question and its answers sit on separate lines.** Beside a docked pane
  the band is narrow, and on one line the question wrapped around its own
  buttons: `Will "Add a 10s timeout to fetchJson and` · buttons · `keep…" land
  first try?`
- **Lives in the row above the prompt.** A bare digit typed into an empty
  prompt answers it: no pane, no focus, nothing to click.
- **`0` always means skip**: waving away a forecast, the file count, or the
  verdict. The verdict's skip used to sit on `3`.
- **A verdict can be undone.** The row keeps `Recorded: Needed fixing · u:
  Undo` until the next turn starts, so a misread verdict is one press rather
  than a wrong score.
- **`0` waves a turn away**, and the row goes quiet for the rest of it.
- **Bets are quoted against what you asked**, and `/bet` names the asks you
  called worst.
- The report leads with the lean in words — `You run 12 points
  overconfident` — before the Brier score, and its calibration table lines up.
- The status line says what to do next: `type 1–5 to call this turn`, then
  `did it land? 1 to answer`.

### Fixes

- A second install with `--marketplace <owner>/<repo>` answered `not found in
  any marketplace`. The repository and the marketplace are now both `waitroom`,
  and the README says which of the two `--marketplace` takes when.

### Credits

The undo for a skipped file and for a verdict, `0` as the one skip key,
`/wait-review` taking focus, the put-off reminder, and the move off the
deprecated `bold` prop came from a parallel pass on this release (#5),
merged into it here.

## 0.1.0

First release: the review pane and the forecast, both in panes.
