# Changelog

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
  than read.
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

## 0.1.0

First release: the review pane and the forecast, both in panes.
