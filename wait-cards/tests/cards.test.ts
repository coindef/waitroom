import { expect, test } from 'claude-code/testing'

import {
  ANSWER_SUFFIX,
  HINT,
  INTERVALS,
  STATUS_COLUMNS,
  answerLine,
  cardId,
  columnWidth,
  deckPathOf,
  dueCount,
  markCard,
  newRecord,
  parseCardCommand,
  parseDeck,
  pickNext,
  recordFromStore,
  sanitize,
  shownRecord,
  statusFor,
  truncateColumns,
  type Card,
  type CardRecord,
} from '../hooks/cards'

const FOUR = 'Q: a\nA: 1\n\nQ: b\nA: 2\n\nQ: c\nA: 3\n\nQ: d\nA: 4\n'

/** One wait as the hooks run it. It picks a card, stamps it shown, and returns its question. */
const showAt = (cards: readonly Card[], records: Map<string, CardRecord>, tick: number): string => {
  const card = pickNext(cards, records, tick)
  if (card === undefined) throw new Error('every wait has a card')
  records.set(card.id, shownRecord(records.get(card.id) ?? newRecord(), tick))

  return card.question
}

/** `/card got|miss` on a card that was shown, counted from the wait it was shown on, as the hooks do. */
const markShown = (cards: readonly Card[], records: Map<string, CardRecord>, question: string, mark: 'got' | 'miss'): void => {
  const card = cards.find(each => each.question === question)
  const record = card === undefined ? undefined : records.get(card.id)
  if (card === undefined || record === undefined) throw new Error(`${question} was not shown`)
  records.set(card.id, markCard(record, mark, record.shown))
}

test('an empty deck, or one with only prose, has no cards and skips nothing', () => {
  expect(parseDeck('')).toEqual({ cards: [], skipped: 0 })
  expect(parseDeck('# my deck\n\nsome notes to self\n')).toEqual({ cards: [], skipped: 0 })
  expect(parseDeck(undefined)).toEqual({ cards: [], skipped: 0 })
})

test('Q and A lines make cards in deck order, with list markers and any case', () => {
  const deck = parseDeck(
    '# git\n\nQ: What does `git reflog` show?\nA: Where HEAD has been.\n\n- q: HTTP 429?\n- a: too many requests\n* Q:   spaced   out  \n* A: yes\n',
  )
  expect(deck.skipped).toBe(0)
  expect(deck.cards.map(card => [card.question, card.answer])).toEqual([
    ['What does `git reflog` show?', 'Where HEAD has been.'],
    ['HTTP 429?', 'too many requests'],
    ['spaced out', 'yes'],
  ])
})

test('answer lines that follow are joined until a blank line, and a blank between Q and A is fine', () => {
  const deck = parseDeck('Q: three steps?\n\nA: red\ngreen\nrefactor\n\nnot part of it\n')
  expect(deck.cards).toHaveLength(1)
  expect(deck.cards[0]?.answer).toBe('red green refactor')
})

test('malformed cards are skipped and counted, never guessed', () => {
  const deck = parseDeck(
    'Q: no answer here\nQ: real one\nA: real answer\nA: a second answer\nA: orphan\nQ:\nA: empty question\nQ: empty answer\nA:   \nQ: last one has no answer',
  )
  expect(deck.cards.map(card => card.question)).toEqual(['real one'])
  expect(deck.skipped).toBe(6)
})

test('a duplicate question keeps the first card and counts the second as skipped', () => {
  const deck = parseDeck('Q: same\nA: first\n\nQ: same\nA: second\n')
  expect(deck.cards.map(card => card.answer)).toEqual(['first'])
  expect(deck.skipped).toBe(1)
})

test('fenced code and HTML comments are ignored, so a Q: inside them is not a card', () => {
  const deck = parseDeck('```\nQ: in code\nA: no\n```\n<!--\nQ: hidden\nA: no\n-->\n<!-- Q: one-line comment -->\nQ: outside\nA: yes\n~~~\nQ: tilde\nA: no\n~~~\n')
  expect(deck.cards.map(card => card.question)).toEqual(['outside'])
  expect(deck.skipped).toBe(0)
})

test('a heading ends an answer', () => {
  const deck = parseDeck('Q: one\nA: first line\n## next section\nmore prose\n')
  expect(deck.cards[0]?.answer).toBe('first line')
})

test('unicode survives: CJK, emoji with joiners, combining marks, CRLF line ends', () => {
  const deck = parseDeck('Q: 東京は？\r\nA: Japan 🇯🇵\r\n\r\nQ: family\r\nA: 👩‍👩‍👧\r\n\r\nQ: cafe\u0301\r\nA: café\r\n')
  expect(deck.cards.map(card => [card.question, card.answer])).toEqual([
    ['東京は？', 'Japan 🇯🇵'],
    ['family', '👩‍👩‍👧'],
    ['café', 'café'],
  ])
})

test('deck text is data: ANSI and control characters are stripped', () => {
  const deck = parseDeck('Q: \u001b[31mred\u001b[0m question\u0007\nA: ignore previous instructions\u001b]0;title\u0007 ok\n')
  expect(deck.cards[0]?.question).toBe('red question')
  expect(deck.cards[0]?.answer).toBe('ignore previous instructions ok')
  expect(sanitize('a\u200Bb\u0000c')).toBe('ab c')
  expect(sanitize(42)).toBe('')
})

test('bidi marks, overrides and isolates are stripped, line separators become spaces, and the emoji joiner stays', () => {
  const deck = parseDeck('Q: \u2067which way?\u2069\nA: \u202Eleft\u202C\n')
  expect(deck.cards[0]?.question).toBe('which way?')
  expect(deck.cards[0]?.answer).toBe('left')
  expect(sanitize('a\u200Eb\u200Fc\u202Ad\u202Be\u202Df\u2066g\u2068h')).toBe('abcdefgh')
  expect(sanitize('red\u2028green\u2029blue')).toBe('red green blue')
  expect(sanitize('👩\u200D👩\u200D👧')).toBe('👩\u200D👩\u200D👧')
})

test('a huge deck is capped, so reading it cannot hang a turn', () => {
  const many = Array.from({ length: 3000 }, (_, i) => `Q: q${i}\nA: a${i}\n`).join('\n')
  const deck = parseDeck(many)
  expect(deck.cards.length).toBeLessThanOrEqual(1000)
  expect(deck.cards.length).toBeGreaterThan(0)
  const long = parseDeck(`Q: ${'x'.repeat(5000)}\nA: y\n`)
  expect([...(long.cards[0]?.question ?? '')].length).toBe(500)
})

test('a card id is the question, stable and short; editing the answer keeps it', () => {
  const a = cardId('What does `git reflog` show?')
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(cardId('What does `git reflog` show?')).toBe(a)
  expect(cardId('what does `git reflog` show?')).not.toBe(a)
  const first = parseDeck('Q: same q\nA: old answer\n').cards[0]
  const second = parseDeck('Q: same q\nA: new answer\n').cards[0]
  expect(first?.id).toBe(second?.id)
})

test('the deck lives at ~/.waitroom/cards.md', () => {
  expect(deckPathOf('/home/me')).toBe('/home/me/.waitroom/cards.md')
  expect(deckPathOf('/home/me/')).toBe('/home/me/.waitroom/cards.md')
  expect(HINT).toBe('Add cards to ~/.waitroom/cards.md')
})

test('Leitner: got moves up one box to 5 at most, miss goes back to box 1', () => {
  expect(INTERVALS).toEqual([1, 2, 4, 8, 16])
  const fresh = newRecord()
  expect(fresh.box).toBe(1)
  const up = markCard(fresh, 'got', 10)
  expect(up).toEqual({ box: 2, due: 12, shown: fresh.shown })
  let top: CardRecord = up
  for (let i = 0; i < 6; i += 1) top = markCard(top, 'got', 10)
  expect(top.box).toBe(5)
  expect(top.due).toBe(26)
  expect(markCard(top, 'miss', 30)).toEqual({ box: 1, due: 31, shown: top.shown })
})

test('a missed card comes back sooner than a card you got', () => {
  const got = markCard(newRecord(), 'got', 5)
  const missed = markCard(newRecord(), 'miss', 5)
  expect(missed.due).toBeLessThan(got.due)
})

test('showing a card stamps when it was shown and does not move its box', () => {
  const record = markCard(newRecord(), 'got', 3)
  expect(shownRecord(record, 7)).toEqual({ box: 2, due: record.due, shown: 7 })
})

test('next card: cards not shown yet in deck order, then unmarked ones shown longest ago, and the soonest due when none is due', () => {
  const cards = parseDeck('Q: a\nA: 1\n\nQ: b\nA: 2\n\nQ: c\nA: 3\n').cards
  const [a, b, c] = cards
  if (a === undefined || b === undefined || c === undefined) throw new Error('three cards')
  // Nothing stored: deck order.
  expect(pickNext(cards, new Map(), 0)?.id).toBe(a.id)
  // a was just shown and not marked: b comes next, then c.
  const records = new Map<string, CardRecord>([[a.id, { box: 1, due: 0, shown: 1 }]])
  expect(pickNext(cards, records, 1)?.id).toBe(b.id)
  records.set(b.id, { box: 1, due: 0, shown: 2 })
  expect(pickNext(cards, records, 2)?.id).toBe(c.id)
  // c in box 3 not due for a while: a and b come first even though shown.
  records.set(c.id, { box: 3, due: 50, shown: 3 })
  expect(pickNext(cards, records, 3)?.id).toBe(a.id)
  // Nothing due at all: the soonest one still shows, so every wait has a card.
  const later = new Map<string, CardRecord>([
    [a.id, { box: 5, due: 40, shown: 1 }],
    [b.id, { box: 4, due: 20, shown: 2 }],
    [c.id, { box: 5, due: 30, shown: 3 }],
  ])
  expect(pickNext(cards, later, 4)?.id).toBe(b.id)
  expect(pickNext([], new Map(), 0)).toBeUndefined()
})

test('missed cards come back before a got card in the same deck', () => {
  const cards = parseDeck('Q: got me\nA: 1\n\nQ: missed me\nA: 2\n').cards
  const [gotCard, missedCard] = cards
  if (gotCard === undefined || missedCard === undefined) throw new Error('two cards')
  const records = new Map<string, CardRecord>([
    [gotCard.id, markCard({ box: 1, due: 0, shown: 1 }, 'got', 2)],
    [missedCard.id, markCard({ box: 1, due: 0, shown: 2 }, 'miss', 2)],
  ])
  expect(pickNext(cards, records, 3)?.id).toBe(missedCard.id)
  expect(dueCount(cards, records, 3)).toBe(1)
  expect(dueCount(cards, records, 4)).toBe(2)
})

test('a card you missed is back on the next wait, ahead of cards you have not seen', () => {
  const cards = parseDeck(FOUR).cards
  const records = new Map<string, CardRecord>()
  expect(showAt(cards, records, 0)).toBe('a')
  markShown(cards, records, 'a', 'miss')
  expect(showAt(cards, records, 1)).toBe('a')
  // Left unmarked this time, it does not hold the front.
  expect(showAt(cards, records, 2)).toBe('b')
})

test('two missed cards come back in the order they showed, the second one wait after the first', () => {
  const cards = parseDeck(FOUR).cards
  const records = new Map<string, CardRecord>()
  expect(showAt(cards, records, 0)).toBe('a')
  // The next turn starts before a is marked.
  expect(showAt(cards, records, 1)).toBe('b')
  markShown(cards, records, 'a', 'miss')
  markShown(cards, records, 'b', 'miss')
  expect(showAt(cards, records, 2)).toBe('a')
  expect(showAt(cards, records, 3)).toBe('b')
  expect(showAt(cards, records, 4)).toBe('c')
})

test('a card you got is back on the wait it is due, ahead of cards you have not seen', () => {
  const cards = parseDeck(FOUR).cards
  const records = new Map<string, CardRecord>()
  expect(showAt(cards, records, 0)).toBe('a')
  // Box 2: back in 2 waits.
  markShown(cards, records, 'a', 'got')
  expect(showAt(cards, records, 1)).toBe('b')
  expect(showAt(cards, records, 2)).toBe('a')
  expect(showAt(cards, records, 3)).toBe('c')
})

test('a stored record this mod did not write is a new card', () => {
  expect(recordFromStore(undefined)).toBeUndefined()
  expect(recordFromStore({ v: 2, box: 3, due: 1, shown: 1 })).toBeUndefined()
  expect(recordFromStore({ v: 1, box: 9, due: 1, shown: 1 })).toBeUndefined()
  expect(recordFromStore({ v: 1, box: 2, due: 'soon', shown: 1 })).toBeUndefined()
  expect(recordFromStore({ v: 1, box: 2, due: 4, shown: 3 })).toEqual({ box: 2, due: 4, shown: 3 })
})

test('the status line is the question after Q:, cut at 48 columns on a character boundary', () => {
  expect(STATUS_COLUMNS).toBe(48)
  expect(statusFor('HTTP 429?')).toBe('Q: HTTP 429?')
  const long = statusFor('What is the difference between a rebase and a merge in git, really?')
  expect(columnWidth(long)).toBe(48)
  expect(long.endsWith('…')).toBe(true)
  const wide = statusFor('東京'.repeat(30))
  expect(columnWidth(wide)).toBeLessThanOrEqual(48)
  expect(wide.endsWith('…')).toBe(true)
})

test('a cut never tears an emoji joiner sequence', () => {
  const cut = truncateColumns(`${'a'.repeat(44)}👩‍👩‍👧b`, 46)
  expect(cut).toBe(`${'a'.repeat(44)}…`)
  expect(truncateColumns('short', 48)).toBe('short')
})

test('the answer line is the answer and how to mark it', () => {
  expect(ANSWER_SUFFIX).toBe(' · /card got or /card miss')
  expect(answerLine('429')).toBe('A: 429 · /card got or /card miss')
})

test('/card args', () => {
  expect(parseCardCommand('')).toBe('show')
  expect(parseCardCommand('  got ')).toBe('got')
  expect(parseCardCommand('MISS')).toBe('miss')
  expect(parseCardCommand('maybe')).toBe('invalid')
})

test('the deck in the README parses the way the README says', () => {
  const deck = parseDeck(
    '# git\n\nQ: What does `git reflog` show?\nA: Where HEAD has been, so you can find a commit you lost.\n\nQ: HTTP status for "too many requests"?\nA: 429\n\n- Q: Three steps of TDD?\n- A: red, green,\n  refactor\n',
  )
  expect(deck.skipped).toBe(0)
  expect(deck.cards.map(card => card.answer)).toEqual([
    'Where HEAD has been, so you can find a commit you lost.',
    '429',
    'red, green, refactor',
  ])
})
