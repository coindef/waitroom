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

- Q: Three steps of TDD?
- A: red, green,
  refactor
```

- `Q:` and `A:` can be any case, and can follow a `- ` or `* ` list marker.
- Lines after the `A:` line join the answer until a blank line, a heading, or the next `Q:`.
- Headings, other text, fenced code blocks and `<!-- comments -->` are skipped, so you can keep notes in the same file.

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

## With no deck

If `~/.waitroom/cards.md` does not exist, or `HOME` is not set, the first turn logs one line:

```text
Add cards to ~/.waitroom/cards.md
```

After that it stays quiet, in this process and in later ones. No sample cards are written. Once a deck turns up, that line is forgotten, so if the file goes away later you see it once more.

A deck with no valid cards is also quiet. `/card` tells you to write a `Q:` line and then an `A:` line.

## Where it is kept

Your progress is kept by Claude Code, never in your deck file. If two sessions mark the same card at once, the last mark wins.

## What it does not do

- It does not call a model, open a connection, or read your transcript.
- It does not add anything to your prompt, and Claude never sees the cards.
- It does not write, generate, or download cards.
- It does not listen for keys while a turn runs. Whether a running turn can take a keypress has not been tested on a real terminal, so v1 uses `/card` after the turn instead.
- It does not import from Anki or share decks.

## Developing

```sh
claude plugin validate ./wait-cards
claude plugin test     ./wait-cards   # 47 tests
```

`hooks/cards.ts` needs no engine. It has the deck parser and its limits, the boxes, which card comes next, the 48-column line and the replies. `hooks/register.ts` has the hooks and the store keys.

A real Claude Code session has not been run against this mod yet. The flow tests mock the engine, and a pass there is not that check.
