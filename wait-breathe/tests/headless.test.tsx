import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * Each headless gate, with `$.session.surfaces()` answered the way a real
 * session answers it (CR on #112, read off real 2.1.319 and 2.1.325 runs):
 *
 * | event         | `claude -p` | interactive REPL |
 * | turn.start    | []          | ['terminal']     |
 * | session.end   | []          | [] (detached)    |
 *
 * So the session-end decision cannot ask `surfaces()` again; it uses what
 * the session's turns saw.
 */

const BAND_PROPS = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: true,
  maxRows: 6,
  bodyColumns: 115,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
} as const

const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: 'wait-breathe',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    viewport: { columns: 120, rows: 30 },
    props: BAND_PROPS,
  })

const NUDGE = /posture|20-20-20|4-4-4|stretch/

type Surface = 'terminal' | 'desktop'

/** The engine beneath: a store that counts writes, a log, and a surfaces answer the test sets. */
const bottom = (on: On, seed?: unknown) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = {}
  if (seed !== undefined) store.state = seed
  const writes = { count: 0 }
  const surfaces: { now: readonly Surface[] | 'reject' } = { now: [] }
  on('session.surfaces', () => {
    if (surfaces.now === 'reject') throw new Error('no implementation')

    return { value: surfaces.now }
  })
  on('store.get', ($, e) => {
    const value = store[e.key]

    return { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }
  })
  on('store.set', ($, e) => {
    writes.count += 1
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  const logged: string[] = []
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })

  return { clock, store, writes, surfaces, logged }
}

const SHORT_FUSE = { options: { enabled: true, longTurnSeconds: 5 } }

const done = (turnId: string, durationMs = 5000) =>
  ({ turnId, answer: 'done', durationMs, isAborted: false, reason: 'answer' }) as const

const end = ($: Engine, sessionId: string) =>
  $.session.end({ reason: 'other', sessionId, resume: { id: sessionId } } as never)

test('turn.start with nothing drawing arms no timer: no nudge, no store write', SHORT_FUSE, async ($, on) => {
  const { clock, writes } = bottom(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await $.turn.start({ text: 'a batch job', turnId: 'p1' })
  await clock.advance(60_000)
  const band = await mountBand($)
  expect(await band.find({ text: NUDGE })).toBeUndefined()
  await band.unmount()
  await $.turn.complete(done('p1', 60_000))
  expect(writes.count).toBe(0)
})

test('turn.start with a terminal attached arms the timer: the nudge shows and is saved', SHORT_FUSE, async ($, on) => {
  const { clock, store, surfaces } = bottom(on)
  surfaces.now = ['terminal']
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'a long one', turnId: 't1' })
  await clock.advance(5000)
  const band = await mountBand($)
  expect((await band.find({ text: NUDGE }))?.text).toContain('posture check: reset how you are sitting')
  await band.unmount()
  expect(store.state).toEqual({ rotation: 1, lastPromptAt: 5000, history: [] })
})

test(
  "a headless session writes nothing at session end, even with another session's nudges in the shared store",
  SHORT_FUSE,
  async ($, on) => {
    // Another window saved a nudge after this run began. Asked by time alone,
    // the store would credit it to this run and the run would log a line.
    const { clock, store, writes, logged } = bottom(on)
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await clock.advance(500)
    const theirs = { rotation: 1, lastPromptAt: 500, history: [{ at: 500, taken: true }] }
    store.state = theirs
    await $.turn.start({ text: 'a batch job', turnId: 'p1' })
    await clock.advance(60_000)
    await $.turn.complete(done('p1', 60_000))
    await end($, 'p1')
    expect(logged).toEqual([])
    expect(writes.count).toBe(0)
    expect(store.state).toEqual(theirs)
  },
)

test(
  'an interactive session whose terminal has detached by session end still logs its line',
  SHORT_FUSE,
  async ($, on) => {
    // CR on #112, H1: in a real REPL `surfaces()` is already [] at session.end.
    const { clock, surfaces, logged } = bottom(on)
    surfaces.now = ['terminal']
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'a long one', turnId: 't1' })
    await clock.advance(5000)
    const band = await mountBand($)
    expect(await band.find({ text: NUDGE })).toBeDefined()
    await band.unmount()
    await $.turn.complete(done('t1'))

    surfaces.now = []
    await end($, 's1')
    expect(logged).toEqual(['1 nudge, 0 taken this session'])
  },
)

test(
  'a surfaces() that rejects (documented never to) counts as drawing, so the nudge is not lost',
  SHORT_FUSE,
  async ($, on) => {
    const { clock, surfaces, logged } = bottom(on)
    surfaces.now = 'reject'
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'a long one', turnId: 't1' })
    await clock.advance(5000)
    const band = await mountBand($)
    expect(await band.find({ text: NUDGE })).toBeDefined()
    await band.unmount()
    await $.turn.complete(done('t1'))
    await end($, 's1')
    expect(logged).toEqual(['1 nudge, 0 taken this session'])
  },
)
