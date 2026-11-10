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

type Given = { deck?: string; home?: boolean; store?: Record<string, unknown>; deckReads?: { count: number } }

const engineBottom = (on: On, given: Given = {}) => {
  const said: (string | undefined)[] = []
  const logged: string[] = []
  const fetched: string[] = []
  const modeled: string[] = []
  const wrote: string[] = []
  const readTranscript = { count: 0 }
  const disk = { deck: given.deck }
  const store: Record<string, unknown> = given.store ?? {}
  mock.env(on, given.home === false ? {} : { HOME })
  on('store.get', ($, e) => ({ value: store[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(store[e.key])) }))
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
    if (e.path !== DECK_PATH || disk.deck === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: disk.deck }
  })
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
  const { said, logged } = engineBottom(on, { deck: '# todo\nQ: no answer yet\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(said.every(text => text === undefined)).toBe(true)
  expect(logged).toEqual([])
  expect(await card($, '')).toBe('no cards in ~/.waitroom/cards.md yet · write a Q: line, then an A: line')
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
  expect(await wait('t3', 'got')).toBe('Q: one')
  expect(await wait('t4', 'miss')).toBe('Q: two')
  // one is in box 3 now, due on wait 6. two was missed on wait 3, so it is back on wait 4.
  await $.turn.start(begin('t5'))
  expect(said.at(-1)).toBe('Q: two')
})
