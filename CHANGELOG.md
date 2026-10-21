# Changelog

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
