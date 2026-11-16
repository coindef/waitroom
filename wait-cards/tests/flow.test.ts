/**
 * The loop through the engine: a question on the status line while a
 * main-loop turn runs, the answer logged once when it ends, `/card got` and
 * `/card miss` moving the card's box in the store, and a quiet hint when
 * there is no deck. Nothing is added to the prompt; no model, no network.
 *
 * Requires `claude plugin test`.
 */

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { cardId } from '../hooks/cards'

const HOME = '/home/me'
const DECK_PATH = '/home/me/.waitroom/cards.md'
const DECK = 'Q: HTTP status for too many requests?\nA: 429\n\nQ: What does `git reflog` show?\nA: Where HEAD has been.\n'

const finish = (turnId: string, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({
    turnId,
    answer: 'done',
    durationMs: 1000,
    isAborted: extra.isAborted === true,
    reason: extra.isAborted === true ? 'aborted' : 'answer',
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  }) as const

const begin = (turnId: string, agentId?: string) =>
  ({ text: 'fix the build', turnId, ...(agentId === undefined ? {} : { agentId }) }) as never

type Given = {
  deck?: string
  home?: boolean
  store?: Record<string, unknown>
  deckReads?: { count: number }
  /** The deck path is there, but reading it fails, as with a folder or a file without read permission. */
  unreadable?: boolean
  /** When this returns true, every `store.get` throws. A resolved missing key stays a missing key. */
  failStoreGet?: () => boolean
  /**
   * After the first read of a card, another session writes this record.
   * That first read still returns the value that was there before.
   */
  remarkAfterRead?: { box: number; due: number; shown: number }
}

const engineBottom = (on: On, given: Given = {}) => {
  const said: (string | undefined)[] = []
  const logged: string[] = []
  const fetched: string[] = []
  const modeled: string[] = []
  const wrote: string[] = []
  const readTranscript = { count: 0 }
  const disk = { deck: given.deck }
  const store: Record<string, unknown> = given.store ?? {}
  let cardReads = 0
  mock.env(on, given.home === false ? {} : { HOME })
  on('store.get', ($, e) => {
    if (given.failStoreGet?.() === true) throw new Error('EIO: store unreadable for a moment')
    if (e.key.startsWith('card/') && given.remarkAfterRead !== undefined && cardReads === 0) {
      cardReads += 1
      const stale = store[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(store[e.key]))
      const next = given.remarkAfterRead
      store[e.key] = { v: 1, box: next.box, due: next.due, shown: next.shown }

      return { value: stale }
    }

    return { value: store[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(store[e.key])) }
  })
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('fs.read', ($, e) => {
    if (given.deckReads !== undefined) given.deckReads.count += 1
    if (e.path === DECK_PATH && given.unreadable === true) throw new Error(`EACCES: permission denied, open '${e.path}'`)
    if (e.path !== DECK_PATH || disk.deck === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: disk.deck }
  })
  on('fs.exists', ($, e) => ({ value: e.path === DECK_PATH && (disk.deck !== undefined || given.unreadable === true) }))
  on('fs.write', ($, e) => {
    wrote.push(e.path)
    throw new Error(`wait-cards writes no file: ${e.path}`)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-cards opens no connection: ${e.url}`)
  })
  on('model.complete', () => {
    modeled.push('complete')
    throw new Error('wait-cards calls no model')
  })
  on('session.messages', () => {
    readTranscript.count += 1
    throw new Error('wait-cards reads no transcript')
  })

  return { said, logged, fetched, modeled, wrote, readTranscript, store, disk }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

const card = async ($: Engine, args: string): Promise<string> => {
  const reply = await $.command.run({ command: 'card', args } as never)
  if (typeof reply.text !== 'string') throw new Error('card returned no text')

  return reply.text
}

const boxes = (store: Record<string, unknown>) =>
  Object.entries(store)
    .filter(([key]) => key.startsWith('card/'))
    .map(([, value]) => (value as { box: number }).box)

test('the question shows on the status line during a turn, and the answer is logged once when it ends', async ($, on) => {
  const { said, logged, fetched, modeled, wrote, readTranscript } = engineBottom(on, { deck: DECK })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('Q: HTTP status for too many requests?')
  expect(logged).toEqual([])

  await $.turn.complete(finish('turn-1'))
  expect(said.at(-1)).toBeUndefined()
  expect(logged).toEqual(['A: 429 · /card got or /card miss'])

  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['A: 429 · /card got or /card miss'])
  expect(fetched).toEqual([])
  expect(modeled).toEqual([])
  expect(wrote).toEqual([])
  expect(readTranscript.count).toBe(0)
})

test('the prompt goes through unchanged', async ($, on) => {
  engineBottom(on, { deck: DECK })
  await start($)
  const sent = await $.prompt.submit({ text: 'fix the build', wait: false, origin: { kind: 'composer' } } as never)
  expect(sent.text).toBe('fix the build')
})

test('an interrupted turn still gets its answer', async ($, on) => {
  const { logged } = engineBottom(on, { deck: DECK })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1', { isAborted: true }))
  expect(logged).toEqual(['A: 429 · /card got or /card miss'])
})

test('a subagent turn neither asks nor answers', async ($, on) => {
  const { said, logged } = engineBottom(on, { deck: DECK })
  await start($)
  await $.turn.start(begin('sub-1', 'worker'))
  expect(said).toEqual([])
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('sub-1', { agentId: 'worker' }))
  expect(logged).toEqual([])
  expect(said.at(-1)).toBe('Q: HTTP status for too many requests?')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['A: 429 · /card got or /card miss'])
})

test('/card got moves the card up a box, and the next wait shows another card', async ($, on) => {
  const { said, store } = engineBottom(on, { deck: DECK })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(await card($, 'got')).toBe('got it · box 2 · back in 2 waits')
  expect(boxes(store)).toEqual([2])

  await $.turn.start(begin('turn-2'))
  expect(said.at(-1)).toBe('Q: What does `git reflog` show?')
})

test('/card miss sends the card to box 1, and a second mark replaces the first', async ($, on) => {
  const { store } = engineBottom(on, { deck: DECK })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(await card($, 'got')).toBe('got it · box 2 · back in 2 waits')
  expect(await card($, 'miss')).toBe('missed · box 1 · back next wait')
  expect(boxes(store)).toEqual([1])
  expect(await card($, 'got')).toBe('got it · box 2 · back in 2 waits')
  expect(boxes(store)).toEqual([2])
})

test('an unmarked card keeps its box, and the next wait moves on', async ($, on) => {
  const { said, store, logged } = engineBottom(on, { deck: DECK })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  await $.turn.start(begin('turn-2'))
  expect(said.at(-1)).toBe('Q: What does `git reflog` show?')
  await $.turn.complete(finish('turn-2'))
  expect(logged.at(-1)).toBe('A: Where HEAD has been. · /card got or /card miss')
  expect(boxes(store)).toEqual([1, 1])
})

test('/card before any answer has nothing to mark and writes nothing', async ($, on) => {
  const { store } = engineBottom(on, { deck: DECK })
  await start($)
  expect(await card($, 'got')).toBe('no card to mark yet · the answer shows when a turn ends')
  await $.turn.start(begin('turn-1'))
  expect(await card($, 'miss')).toBe('no card to mark yet · the answer shows when a turn ends')
  expect(boxes(store)).toEqual([1])
  expect(Object.values(store).every(value => (value as { box?: number }).box !== 0)).toBe(true)
})

test('/card with no args counts the deck, and a word it does not know prints the usage', async ($, on) => {
  engineBottom(on, { deck: `${DECK}\nQ: orphan question\n` })
  await start($)
  expect(await card($, '')).toBe('2 cards · 2 due · 1 skipped · mark an answer with /card got or /card miss')
  expect(await card($, 'later')).toBe('/card got · /card miss')
})

test('no deck: the hint is logged once across turns and a second load, with no status line', async ($, on) => {
  const { said, logged, store, wrote } = engineBottom(on)
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  await $.turn.start(begin('turn-2'))
  await $.turn.complete(finish('turn-2'))
  expect(logged).toEqual(['Add cards to ~/.waitroom/cards.md'])
  expect(said.every(text => text === undefined)).toBe(true)
  expect(wrote).toEqual([])
  expect(store.hint).toEqual({ v: 1 })
  expect(await card($, '')).toBe('no deck yet · Add cards to ~/.waitroom/cards.md')
  expect(await card($, 'got')).toBe('no card to mark yet · the answer shows when a turn ends')
})

test('a stored hint stays quiet in a new process, and a deck turning up clears it', async ($, on) => {
  const { logged, store, disk, said } = engineBottom(on, { store: { hint: { v: 1 } } })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(logged).toEqual([])
  disk.deck = DECK
  await $.turn.complete(finish('turn-1'))
  await $.turn.start(begin('turn-2'))
  expect(said.at(-1)).toBe('Q: HTTP status for too many requests?')
  expect(store.hint).toBeUndefined()
})

test('a deck with no valid cards is quiet, and /card says how to write one', async ($, on) => {
  const { said, logged, disk } = engineBottom(on, { deck: '# todo\nQ: no answer yet\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(said.every(text => text === undefined)).toBe(true)
  expect(logged).toEqual([])
  expect(await card($, '')).toBe('no cards in ~/.waitroom/cards.md yet · write a Q: line, then an A: line · 1 skipped')
  disk.deck = '<!--\nQ: hidden\nA: no\n\nQ: also\nA: no\n'
  expect(await card($, '')).toBe('no cards in ~/.waitroom/cards.md yet · write a Q: line, then an A: line · 2 skipped')
})

test('a deck file that is there but cannot be read logs no hint and shows no card, and /card says so', async ($, on) => {
  const { said, logged, store } = engineBottom(on, { unreadable: true })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual([])
  expect(said.every(text => text === undefined)).toBe(true)
  expect(store.hint).toBeUndefined()
  expect(await card($, '')).toBe("can't read ~/.waitroom/cards.md")
})

test('no HOME is the same as no deck', async ($, on) => {
  const { logged, said } = engineBottom(on, { home: false, deck: DECK })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.every(text => text === undefined)).toBe(true)
  expect(logged).toEqual(['Add cards to ~/.waitroom/cards.md'])
})

test('deck text with ANSI shows cleaned on the status line and in the answer', async ($, on) => {
  const { said, logged } = engineBottom(on, { deck: 'Q: \u001b[31mred?\u001b[0m\nA: \u001b[2Jcleared\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('Q: red?')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['A: cleared · /card got or /card miss'])
})

test('a missed card comes back while the one you got waits its turn', async ($, on) => {
  const { said } = engineBottom(on, { deck: 'Q: one\nA: 1\n\nQ: two\nA: 2\n' })
  await start($)
  const wait = async (turnId: string, mark: 'got' | 'miss'): Promise<string | undefined> => {
    await $.turn.start(begin(turnId))
    const question = said.at(-1)
    await $.turn.complete(finish(turnId))
    await card($, mark)

    return question
  }
  expect(await wait('t1', 'got')).toBe('Q: one')
  expect(await wait('t2', 'miss')).toBe('Q: two')
  // two was missed on wait 1, so it is back on wait 2. one, got on wait 0, is due then too and waits.
  expect(await wait('t3', 'got')).toBe('Q: two')
  expect(await wait('t4', 'miss')).toBe('Q: one')
  // one was missed on wait 3, so it is back on wait 4, ahead of two, which is due then too.
  await $.turn.start(begin('t5'))
  expect(said.at(-1)).toBe('Q: one')
})

test('/card miss says back next wait, and the next wait shows that card before the ones not seen yet', async ($, on) => {
  const { said } = engineBottom(on, { deck: 'Q: one\nA: 1\n\nQ: two\nA: 2\n\nQ: three\nA: 3\n\nQ: four\nA: 4\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('Q: one')
  await $.turn.complete(finish('turn-1'))
  expect(await card($, 'miss')).toBe('missed · box 1 · back next wait')
  await $.turn.start(begin('turn-2'))
  expect(said.at(-1)).toBe('Q: one')
})

test('a card that is not due stays off the line, and got waits 2, then 4, then 8', async ($, on) => {
  const { said, store } = engineBottom(on, { deck: 'Q: only\nA: one\n' })
  await start($)
  const questions: (string | undefined)[] = []
  const replies: string[] = []
  for (const turnId of ['t0', 't1', 't2', 't3', 't4', 't5', 't6']) {
    await $.turn.start(begin(turnId))
    const question = said.at(-1)
    questions.push(question)
    await $.turn.complete(finish(turnId))
    if (question !== undefined) replies.push(await card($, 'got'))
  }
  const saved = store[`card/${cardId('only')}`] as { box?: number } | undefined

  expect({ questions, replies, box: saved?.box }).toEqual({
    questions: ['Q: only', undefined, 'Q: only', undefined, undefined, undefined, 'Q: only'],
    replies: [
      'got it · box 2 · back in 2 waits',
      'got it · box 3 · back in 4 waits',
      'got it · box 4 · back in 8 waits',
    ],
    box: 4,
  })
})

test('a store read that throws writes nothing, and a bad record is reset once', async ($, on) => {
  const key = `card/${cardId('only')}`
  let fail = true
  const { said, store } = engineBottom(on, {
    deck: 'Q: only\nA: one\n',
    store: {
      tick: { v: 1, n: 7 },
      [key]: { v: 1, box: 3, due: 12, shown: 4 },
    },
    failStoreGet: () => fail,
  })
  await start($)
  await $.turn.start(begin('t1'))
  expect({
    tick: store.tick,
    card: store[key],
    status: said.at(-1),
  }).toEqual({
    tick: { v: 1, n: 7 },
    card: { v: 1, box: 3, due: 12, shown: 4 },
    status: undefined,
  })

  await $.turn.complete(finish('t1'))
  fail = false
  store.tick = { v: 2, n: 40 }
  store[key] = { v: 1, box: 2, due: -3, shown: -4 }
  await $.turn.start(begin('t2'))
  expect({
    status: said.at(-1),
    tick: store.tick,
    card: store[key],
  }).toEqual({
    status: 'Q: only',
    tick: { v: 1, n: 1 },
    card: { v: 1, box: 1, due: 0, shown: 0 },
  })

  // A resolved missing key is a new card, not a failed read.
  delete store[key]
  await $.turn.complete(finish('t2'))
  await $.turn.start(begin('t3'))
  expect(store[key]).toEqual({ v: 1, box: 1, due: 0, shown: 1 })
  expect(store.tick).toEqual({ v: 1, n: 2 })
})

test('showing a card keeps a mark written after it was read', async ($, on) => {
  const key = `card/${cardId('only')}`
  const { said, store } = engineBottom(on, {
    deck: 'Q: only\nA: one\n',
    store: {
      tick: { v: 1, n: 5 },
      [key]: { v: 1, box: 2, due: 5, shown: 1 },
    },
    remarkAfterRead: { box: 4, due: 20, shown: 1 },
  })
  await start($)
  await $.turn.start(begin('t1'))
  expect(said.at(-1)).toBe('Q: only')
  expect(store[key]).toEqual({ v: 1, box: 4, due: 20, shown: 5 })
  expect(store.tick).toEqual({ v: 1, n: 6 })
  await $.turn.complete(finish('t1'))
  expect(await card($, 'got')).toBe('got it · box 4 · back in 15 waits')
  expect(store[key]).toEqual({ v: 1, box: 4, due: 20, shown: 5 })
})

test('/card says when the deck was capped or cut', async ($, on) => {
  const many = Array.from({ length: 1001 }, (_, i) => `Q: q${i}\nA: a${i}\n`).join('\n')
  const { disk } = engineBottom(on, { deck: many })
  await start($)
  expect(await card($, '')).toBe(
    '1000 of 1001 cards · deck capped at 1000 · 1000 due · mark an answer with /card got or /card miss',
  )

  disk.deck = `Q: q\nA: ${'y'.repeat(256 * 1024)}\n\nQ: later\nA: z\n`
  expect(await card($, '')).toBe(
    '1 card · deck cut at 256 KiB · 1 due · mark an answer with /card got or /card miss',
  )
})

test('a bad tick continues from the cards, so a far due wait is not a silent deck', async ($, on) => {
  const one = `card/${cardId('one')}`
  const two = `card/${cardId('two')}`
  const { said, store } = engineBottom(on, {
    deck: 'Q: one\nA: 1\n\nQ: two\nA: 2\n',
    store: {
      tick: { v: 1, n: 'oops' },
      [one]: { v: 1, box: 2, due: 2001, shown: 1999 },
      [two]: { v: 1, box: 2, due: 2003, shown: 2001 },
    },
  })
  await start($)
  expect(await card($, '')).toBe('2 cards · 1 due · mark an answer with /card got or /card miss')
  await $.turn.start(begin('t1'))
  expect(said.at(-1)).toBe('Q: one')
  expect(store.tick).toEqual({ v: 1, n: 2003 })
  expect(store[one]).toEqual({ v: 1, box: 2, due: 2001, shown: 2002 })
  expect(store[two]).toEqual({ v: 1, box: 2, due: 2003, shown: 2001 })
})

test('/card says the progress could not be read, and writes nothing', async ($, on) => {
  const key = `card/${cardId('only')}`
  const saved = {
    tick: { v: 1, n: 7 },
    [key]: { v: 1, box: 3, due: 12, shown: 4 },
  }
  const { store } = engineBottom(on, {
    deck: 'Q: only\nA: one\n',
    store: saved,
    failStoreGet: () => true,
  })
  await start($)
  expect(await card($, '')).toBe("couldn't read your progress · nothing was changed · try /card again")
  expect(store.tick).toEqual({ v: 1, n: 7 })
  expect(store[key]).toEqual({ v: 1, box: 3, due: 12, shown: 4 })
})
