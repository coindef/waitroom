# wait-cards

One flashcard from your own deck, every time you wait on Claude.

The question shows while Claude works. The answer shows when the turn ends. You write the cards. This mod reads them and never writes them.

```sh
claude plugin marketplace add coindef/waitroom
claude plugin install wait-cards@waitroom
```

Needs Claude Code 2.1.318 or later. Restart after installing.

## Your deck

Put your cards in `~/.waitroom/cards.md`. Each card is a `Q:` line and then an `A:` line:

```markdown
# git

Q: What does `git reflog` show?
A: Where HEAD has been, so you can find a commit you lost.

Q: HTTP status for "too many requests"?
A: 429

- Q: Three steps of TDD?
- A: red, green,
  refactor
```

- `Q:` and `A:` can be any case, and can follow a `- ` or `* ` list marker.
- Lines after the `A:` line join the answer until a blank line, a heading, or the next `Q:`.
- Headings, other text, fenced code blocks and `<!-- comments -->` are skipped, so you can keep notes in the same file.
- A `Q:` with no `A:`, an `A:` with no `Q:`, an empty side, and a question that is already in the deck are skipped. `/card` tells you how many lines it skipped. This mod never guesses a missing answer.
- Color codes and control characters are stripped. A question or an answer keeps its first 500 characters. The first 256 KiB of the file and the first 1,000 cards are read.

Edit the file whenever you like. It is read again at the start of each turn. Changing an answer keeps the card's box. Changing the question makes it a new card.

## What you see

While a main-loop turn runs, this mod's status line shows the question:

```text
Q: What does `git reflog` show?
```

Past 48 columns the line ends in `…`, on a character boundary. The deck keeps the whole question.

When the turn ends, the status line clears and one line is logged:

```text
A: Where HEAD has been, so you can find a commit you lost. · /card got or /card miss
```

The answer is logged once. It is shown to you and is not sent to Claude. An interrupted turn gets its answer too. A subagent's turn does not show a card.

Claude Code draws one status line per mod and chooses the order. This mod does not use the row above the prompt, so the bet's question and its keys stay where they are.

## Commands

| Command | What it does |
| --- | --- |
| `/card got` | You knew it. The last answered card moves up one box |
| `/card miss` | You didn't. The last answered card goes back to box 1 |
| `/card` | Counts your cards, how many are due, and how many lines were skipped |

Marking is optional. A card you don't mark keeps its box. If you mark the same card twice, the second mark replaces the first. A mark applies to the last answer shown in this Claude Code process, so after a restart there is nothing to mark until the next answer.

The reply is the command's own text. It does not start a turn.

## Which card comes next

There are five boxes. A new card starts in box 1. The boxes count waits, not days. A wait is one main-loop turn that showed a card.

| Box | Back after |
| --- | --- |
| 1 | the next wait |
| 2 | 2 waits |
| 3 | 4 waits |
| 4 | 8 waits |
| 5 | 16 waits |

`/card got` moves a card up one box, up to box 5. `/card miss` sends it to box 1, so a card you missed comes back sooner than one you got.

Each wait shows a card that is due. When several are due, the one shown longest ago goes first, then the lower box, then deck order. If nothing is due, the card due soonest shows anyway.

## With no deck

If `~/.waitroom/cards.md` does not exist, or `HOME` is not set, the first turn logs one line:

```text
Add cards to ~/.waitroom/cards.md
```

After that it stays quiet, in this process and in later ones. No sample cards are written. Once a deck turns up, that line is forgotten, so if the file goes away later you see it once more.

A deck with no valid cards is also quiet. `/card` tells you to write a `Q:` line and then an `A:` line.

## Where it is kept

This mod reads one file, `~/.waitroom/cards.md`, and does not write to it. It writes no other file either.

It keeps three kinds of values in this plugin's `$.store`. Claude keeps the store under its configuration directory, and this mod does not choose the file name.

| Key | Value |
| --- | --- |
| `card/<id>` | One card's box, the wait it is due on, and the wait it was last shown on. `<id>` is the first 16 hex characters of the SHA-256 of the question. The question and answer text are not stored |
| `tick` | How many waits have shown a card |
| `hint` | Present once the no-deck line has been shown |

Every session on the machine shares these values, because they all share one deck. Each card is its own key, so two sessions that mark different cards don't overwrite each other. Two sessions that mark the same card at the same moment can: the last write wins. Two sessions that start a turn at the same moment can read the same `tick`, which only changes which card comes next.

## What it does not do

- It does not call a model, open a connection, or read your transcript.
- It does not add anything to your prompt, and Claude never sees the cards.
- It does not write, generate, or download cards.
- It does not listen for keys while a turn runs. Whether a running turn can take a keypress has not been tested on a real terminal, so v1 uses `/card` after the turn instead.
- It does not import from Anki or share decks.

## Developing

```sh
claude plugin validate ./wait-cards
claude plugin test     ./wait-cards   # 41 tests
```

`hooks/cards.ts` has the deck parser, the boxes, the 48-column line and the replies, with no engine. `hooks/register.ts` is the hooks. `tests/cards.test.ts` tests the pure module. `tests/flow.test.ts` drives the hooks through the engine with the deck file, the store and the UI mocked. `tests/load-shape.test.ts` checks that `$` is only passed to top-level helpers, the rule that kept wait-anchor from loading on Claude Code 2.1.318.

`claude plugin test` runs 41 tests:

- 23 pure tests
- 15 engine flow tests
- 3 load-shape tests

A real Claude Code session has not been run against this mod yet. The flow tests mock the engine, and a pass there is not that check.
