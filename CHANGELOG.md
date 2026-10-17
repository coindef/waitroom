# Changelog

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
