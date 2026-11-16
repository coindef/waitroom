# wait-cards

One flashcard from your own deck, every time you wait on Claude.

The question shows while Claude works. The answer shows when the turn ends. You write the cards. This mod reads them and never writes them.

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install wait-cards@waitroom
```

Needs Claude Code 2.1.319 or later. Restart after installing.

## Your deck

Put your cards in `~/.waitroom/cards.md`. Each card is a `Q:` line and then an `A:` line:

```markdown
# git

Q: What does `git reflog` show?
A: Where HEAD has been, so you can find a commit you lost.

Q: HTTP status for "too many requests"?
A: 429
```

Headings and other notes in the file are skipped. A block of lines that starts with `<!--` is skipped too, through the line that closes it with `-->`. A `<!--` on a `Q:` or `A:` line is part of that card. If a comment never closes, the cards under it are left out and `/card` counts them as skipped.

Up to 1000 cards are kept, from the first 256 KiB of the file. `/card` says when the rest was left out. Edit the file whenever you like. It is read again at the start of each turn.

## What you see

While Claude works, the status line shows the question. Claude Code adds the ⚠ and the mod's name in front.

```text
⚠ wait-cards: Q: What does `git reflog` show?
```

When the turn ends, one line shows the answer. Claude never sees it.

```text
A: Where HEAD has been, so you can find a commit you lost. · /card got or /card miss
```

## Commands

| Command | What it does |
| --- | --- |
| `/card got` | You knew it. It comes back later each time: 2, 4, 8, then 16 waits |
| `/card miss` | You didn't. It comes back on the next wait |
| `/card` | Counts your cards and how many are due |

Marking is optional. A card you don't mark keeps its place. A card shows when it is due. When none is due, the line stays clear. Marking a card that was not due does not move its box, and the reply names the waits still left. `/card got` on a card that was due waits 2, then 4, then 8, then 16.

If the saved count of waits isn't a real number, the deck continues from the cards you already have, so the line does not stay clear for the old count. If that progress can't be read at all, `/card` says so and nothing is changed.

If two sessions mark the same card, the last mark wins. Editing an answer keeps the card's progress. Editing a question starts a new card; paste the old question back and its box returns. A card you delete keeps its record, so pasting it back brings its box too.

With no deck, the first turn shows `Add cards to ~/.waitroom/cards.md` once, then it stays quiet.

## What it does not do

- It does not call a model or open a connection.
- Claude never sees your cards.
- It never writes to your deck. Your progress is kept in Claude Code's plugin storage.

## Developing

```sh
claude plugin validate ./wait-cards
claude plugin test     ./wait-cards   # 55 tests
```
