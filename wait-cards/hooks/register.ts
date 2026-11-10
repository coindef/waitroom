import type { EngineInterface, Register } from 'claude-code'

import {
  HINT,
  NO_CARDS,
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

/** The deck file as text, or undefined with no `HOME`, no file, or one that cannot be read. Read only. */
const readDeck = async ($: EngineInterface): Promise<Deck | undefined> => {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home.trim() === '') return undefined
  const text = await $.fs.read(deckPathOf(home.trim())).catch(() => undefined)
  if (typeof text !== 'string') return undefined

  return parseDeck(text)
}

/** Waits shown so far, across every session of this plugin. */
const readTick = async ($: EngineInterface): Promise<number> => {
  const raw = await $.store.get(TICK_KEY).catch(() => undefined)
  const n = typeof raw === 'object' && raw !== null ? (raw as { n?: unknown }).n : undefined

  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0
}

const readRecords = async ($: EngineInterface, cards: readonly Card[]): Promise<Map<string, CardRecord>> => {
  const rows = await Promise.all(
    cards.map(async card => [card.id, recordFromStore(await $.store.get(cardKey(card.id)).catch(() => undefined))] as const),
  )
  const records = new Map<string, CardRecord>()
  for (const [id, record] of rows) if (record !== undefined) records.set(id, record)

  return records
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

/** A main-loop turn started: put one question on the status line. */
const ask = async ($: EngineInterface, memory: Memory): Promise<void> => {
  const deck = await readDeck($)
  if (deck === undefined) {
    await hintOnce($, memory)
    return
  }
  await forgetHint($, memory)
  if (deck.cards.length === 0) return
  const tick = await readTick($)
  const records = await readRecords($, deck.cards)
  const card = pickNext(deck.cards, records, tick)
  if (card === undefined) return
  const record = shownRecord(records.get(card.id) ?? newRecord(), tick)
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
  const record = markCard(shown.record, kind, shown.tick)
  await $.store.set(cardKey(shown.card.id), toStored(record))

  return markedLine(kind, record)
}

/** `/card`: how big the deck is and how much is due. */
const describe = async ($: EngineInterface): Promise<string> => {
  const deck = await readDeck($)
  if (deck === undefined) return NO_DECK
  if (deck.cards.length === 0) return NO_CARDS
  const tick = await readTick($)
  const records = await readRecords($, deck.cards)

  return deckLine(deck, dueCount(deck.cards, records, tick))
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
