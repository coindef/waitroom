import type { EngineInterface, Register } from 'claude-code'

import {
  CANT_READ,
  HINT,
  NO_DECK,
  NOTHING_TO_MARK,
  USAGE,
  answerLine,
  deckLine,
  deckPathOf,
  dueCount,
  markCard,
  markedLine,
  newRecord,
  noCardsLine,
  notDueLine,
  parseCardCommand,
  parseDeck,
  pickNext,
  recordFromStore,
  shownRecord,
  statusFor,
  toStored,
  type Card,
  type CardRecord,
  type Deck,
  type Mark,
} from './cards'

/** The card on screen, or the last one answered, as this process saw it. */
type Shown = { card: Card; record: CardRecord; tick: number }

/**
 * What one `register` call remembers. Created inside `register` and passed in,
 * because `$` may only be handed to the top-level helpers below.
 */
type Memory = {
  /** The question on the status line, waiting for its turn to end. */
  asking: Shown | undefined
  /** The last answer logged. `/card got|miss` marks this one. */
  answered: Shown | undefined
  /** The no-deck hint was already logged, or found in the store, in this process. */
  hinted: boolean
}

const TICK_KEY = 'tick'
const HINT_KEY = 'hint'
const cardKey = (id: string): string => `card/${id}`

/**
 * The parsed deck, read only. It is undefined with no `HOME` or no file, and
 * `unreadable` when the file is there but can't be read, such as a folder or
 * a file without read permission.
 */
const readDeck = async ($: EngineInterface): Promise<Deck | 'unreadable' | undefined> => {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home.trim() === '') return undefined
  const path = deckPathOf(home.trim())
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text === 'string') return parseDeck(text)
  const isThere = await $.fs.exists(path).catch(() => false)

  return isThere ? 'unreadable' : undefined
}

type Read = { ok: true; value: unknown } | { ok: false }

/**
 * One store read.
 *
 * `ok: false` means the get threw. That is not a missing key: callers skip
 * this turn's writes, so a blip cannot replace the real tick and cards.
 * A resolved value is returned as it is, including `undefined`.
 */
const readValue = async ($: EngineInterface, key: string): Promise<Read> => {
  try {
    return { ok: true, value: await $.store.get(key) }
  } catch {
    return { ok: false }
  }
}

/**
 * Waits shown so far. A missing key, a wrong `v`, a bad `n`, or a negative
 * `n` is wait 0, and the next successful turn writes a real tick over it.
 * A thrown read is `ok: false` and is not wait 0.
 */
const readTick = async ($: EngineInterface): Promise<{ ok: true; value: number } | { ok: false }> => {
  const read = await readValue($, TICK_KEY)
  if (!read.ok) return read
  const raw = read.value
  if (typeof raw !== 'object' || raw === null) return { ok: true, value: 0 }
  const row = raw as { v?: unknown; n?: unknown }
  const n = row.n
  if (row.v !== 1 || typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { ok: true, value: 0 }

  return { ok: true, value: n }
}

/**
 * One record per card that still reads as one this mod wrote.
 *
 * A missing key and a present value that is not a record are both a new card
 * (left out of the map). The show writes that new card, so one bad value does
 * not stick. Any thrown read fails the whole load: this turn writes nothing.
 */
const readRecords = async (
  $: EngineInterface,
  cards: readonly Card[],
): Promise<{ ok: true; value: Map<string, CardRecord> } | { ok: false }> => {
  const reads = await Promise.all(cards.map(async card => ({ id: card.id, read: await readValue($, cardKey(card.id)) })))
  if (reads.some(row => !row.read.ok)) return { ok: false }
  const records = new Map<string, CardRecord>()
  for (const row of reads) {
    if (!row.read.ok) continue
    const record = recordFromStore(row.read.value)
    if (record !== undefined) records.set(row.id, record)
  }

  return { ok: true, value: records }
}

/** No deck: one line, once. The store keeps that it was said, so a new process stays quiet too. */
const hintOnce = async ($: EngineInterface, memory: Memory): Promise<void> => {
  if (memory.hinted) return
  memory.hinted = true
  const said = await $.store.get(HINT_KEY).catch(() => undefined)
  if (said !== undefined) return
  $.ui.log(HINT)
  await $.store.set(HINT_KEY, { v: 1 }).catch(() => undefined)
}

/** A deck turned up: forget the hint, so it can show once more if the deck goes away. */
const forgetHint = async ($: EngineInterface, memory: Memory): Promise<void> => {
  memory.hinted = false
  const said = await $.store.get(HINT_KEY).catch(() => undefined)
  if (said !== undefined) await $.store.delete(HINT_KEY).catch(() => undefined)
}

/** A main-loop turn started: put one question on the status line. A deck that is there but can't be read shows nothing. */
const ask = async ($: EngineInterface, memory: Memory): Promise<void> => {
  const deck = await readDeck($)
  if (deck === undefined) {
    await hintOnce($, memory)
    return
  }
  if (deck === 'unreadable') return
  await forgetHint($, memory)
  if (deck.cards.length === 0) return
  const tickRead = await readTick($)
  if (!tickRead.ok) return
  const recordsRead = await readRecords($, deck.cards)
  if (!recordsRead.ok) return
  const tick = tickRead.value
  const card = pickNext(deck.cards, recordsRead.value, tick)
  // The wait still counts when nothing is due, or the promised gap never elapses.
  if (card === undefined) {
    await $.store.set(TICK_KEY, { v: 1, n: tick + 1 }).catch(() => undefined)
    return
  }
  // Read this card again and change `shown` only. The box and due wait come
  // from this read, not the copy pickNext used, so a mark made in between stays.
  const fresh = await readValue($, cardKey(card.id))
  if (!fresh.ok) return
  const record = shownRecord(recordFromStore(fresh.value) ?? newRecord(), tick)
  memory.asking = { card, record, tick }
  $.ui.status(statusFor(card.question))
  await $.store.set(cardKey(card.id), toStored(record)).catch(() => undefined)
  await $.store.set(TICK_KEY, { v: 1, n: tick + 1 }).catch(() => undefined)
}

/** The turn ended: clear the question and log its answer, once. */
const answer = ($: EngineInterface, memory: Memory): void => {
  const shown = memory.asking
  if (shown === undefined) return
  memory.asking = undefined
  memory.answered = shown
  $.ui.status(undefined)
  $.ui.log(answerLine(shown.card.answer))
}

/** `/card got|miss`: move the last answered card. A second mark replaces the first. */
const mark = async ($: EngineInterface, memory: Memory, kind: Mark): Promise<string> => {
  const shown = memory.answered
  if (shown === undefined) return NOTHING_TO_MARK
  // On screen before it was due: not a review. Leave the box and the due wait.
  if (shown.record.due > shown.tick) return notDueLine(kind, shown.record, shown.tick)
  const record = markCard(shown.record, kind, shown.tick)
  await $.store.set(cardKey(shown.card.id), toStored(record))

  return markedLine(kind, record)
}

/** `/card`: how big the deck is and how much is due. */
const describe = async ($: EngineInterface): Promise<string> => {
  const deck = await readDeck($)
  if (deck === undefined) return NO_DECK
  if (deck === 'unreadable') return CANT_READ
  if (deck.cards.length === 0) return noCardsLine(deck)
  const tickRead = await readTick($)
  if (!tickRead.ok) throw new Error('store unread')
  const recordsRead = await readRecords($, deck.cards)
  if (!recordsRead.ok) throw new Error('store unread')

  return deckLine(deck, dueCount(deck.cards, recordsRead.value, tickRead.value))
}

export const register: Register = on => {
  const memory: Memory = { asking: undefined, answered: undefined, hinted: false }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'card', description: 'Mark the last flashcard', argumentHint: 'got · miss' })
    } catch {
      // Cards still show. The command is registered again on the next start.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /** A main-loop turn starts. A subagent's turn is not a wait of yours. */
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await ask($, memory)
      } catch {
        // No card this wait. The turn goes on.
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /** The main-loop turn ended, finished or interrupted. The answer is a log line for you, not for Claude. */
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    try {
      answer($, memory)
    } catch {
      // The turn's answer is already decided.
    }

    return done
  }).catch(($, e, next) => next(e))

  /** `/card` answers here and does not start a turn. */
  on('command.run', { command: 'card' }, async ($, e) => {
    const command = parseCardCommand(e.args)
    try {
      if (command === 'invalid') return { text: USAGE }
      if (command === 'show') return { text: await describe($) }

      return { text: await mark($, memory, command) }
    } catch {
      return { text: 'the card could not be saved · try /card again' }
    }
  })
}
