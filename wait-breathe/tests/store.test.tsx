import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * A failed `$.store.get` is not written back: the saved cooldown, rotation,
 * and history stay, and the raise shows nothing. A value that is present but
 * not a record this mod wrote is expired. The next due nudge replaces it, so
 * the nudges come back.
 */

const BAND = {
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 30 },
} as const

const bandProps = (isWorking: boolean) =>
  ({
    hasSurvey: false,
    isWorking,
    maxRows: 6,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  }) as const

const mountBand = ($: Engine, isWorking = true) =>
  $.ui.mount({ plugin: 'wait-breathe', surface: 'terminal', ...BAND, props: bandProps(isWorking) })

const NUDGE = /posture|20-20-20|4-4-4|stretch/

const wire = (on: On, opts: { failGetAt?: number; seed?: unknown } = {}) => {
  const store: Record<string, unknown> = {}
  if ('seed' in opts) store.state = opts.seed
  let gets = 0
  const writes = { count: 0 }
  const clock = mock.clock(on)
  on('store.get', ($, e) => {
    gets += 1
    if (opts.failGetAt === gets) throw new Error('EIO')
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
  on('ui.log', () => ({ value: undefined }))

  return { clock, store, writes }
}

const SHORT_FUSE = { options: { enabled: true, longTurnSeconds: 5 } }

const PRIOR = [
  { at: 10, taken: true },
  { at: 20, taken: false },
]

test(
  'a rejected store read when the nudge would be raised does not write and does not show it',
  SHORT_FUSE,
  async ($, on) => {
    // lastPromptAt 0 at t=5s is inside the ten minutes. A read that throws
    // must not be treated as "no record", which would show the first message
    // and replace this one.
    const seed = { rotation: 3, lastPromptAt: 0, history: PRIOR }
    const { clock, store, writes } = wire(on, { failGetAt: 1, seed })
    await $.turn.start({ text: 'again too soon', turnId: 'bypass' })
    await clock.advance(5000)
    const band = await mountBand($)
    expect(await band.find({ text: NUDGE })).toBeUndefined()
    await band.unmount()
    expect(writes.count).toBe(0)
    expect(store.state).toEqual(seed)
  },
)

test(
  'a rejected store read when the nudge is recorded does not write over the saved record',
  SHORT_FUSE,
  async ($, on) => {
    const seed = { rotation: 0, lastPromptAt: null, history: [{ at: 1, taken: true }] }
    const { clock, store, writes } = wire(on, { failGetAt: 2, seed })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'long', turnId: 't1' })
    await clock.advance(5000)
    const first = await mountBand($)
    expect((await first.find({ text: NUDGE }))?.text).toContain('posture check: reset how you are sitting')
    await first.unmount()
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer' })
    // The raise was stored. The record's own read failed, so that write stands
    // and the older history is still there.
    expect(writes.count).toBe(1)
    expect(store.state).toEqual({ rotation: 1, lastPromptAt: 5000, history: seed.history })
    await $.turn.start({ text: 'soon', turnId: 't2' })
    await clock.advance(5000)
    const second = await mountBand($)
    expect(await second.find({ text: NUDGE })).toBeUndefined()
    await second.unmount()
    expect(writes.count).toBe(1)
    expect(store.state).toEqual({ rotation: 1, lastPromptAt: 5000, history: seed.history })
  },
)

test(
  'a stored value that is not an object is replaced the next time a nudge is due',
  SHORT_FUSE,
  async ($, on) => {
    const { clock, store, writes } = wire(on, { seed: 'not-a-record' })
    await $.turn.start({ text: 'long', turnId: 'bad-object' })
    await clock.advance(5000)
    const band = await mountBand($)
    expect((await band.find({ text: NUDGE }))?.text).toContain('posture check: reset how you are sitting')
    await band.unmount()
    expect(store.state).toEqual({ rotation: 1, lastPromptAt: 5000, history: [] })
    await $.turn.complete({
      turnId: 'bad-object',
      answer: 'done',
      durationMs: 5000,
      isAborted: false,
      reason: 'answer',
    })
    expect(store.state).toEqual({
      rotation: 1,
      lastPromptAt: 5000,
      history: [{ at: 5000, taken: false }],
    })
    // The fresh record's cooldown holds. The next long turn inside ten minutes is quiet.
    await $.turn.start({ text: 'soon', turnId: 'bad-object-2' })
    await clock.advance(5000)
    const second = await mountBand($)
    expect(await second.find({ text: NUDGE })).toBeUndefined()
    await second.unmount()
    expect(writes.count).toBe(2)
  },
)

test('a corrupt record self-heals', SHORT_FUSE, async ($, on) => {
  // lastPromptAt is inside the ten minutes, and the history is not a list of
  // events. Trusting it would stay quiet forever. It is stale: the next due
  // nudge starts a fresh record, and a later long turn still gets one.
  const seed = { rotation: 3, lastPromptAt: 0, history: { not: 'a list' } }
  const { clock, store, writes } = wire(on, { seed })
  await $.turn.start({ text: 'long', turnId: 'heal-1' })
  await clock.advance(4999)
  expect(writes.count).toBe(0)
  expect(store.state).toEqual(seed)

  await clock.advance(1)
  const first = await mountBand($)
  expect((await first.find({ text: NUDGE }))?.text).toContain('posture check: reset how you are sitting')
  await first.unmount()
  expect(store.state).toEqual({ rotation: 1, lastPromptAt: 5000, history: [] })
  await $.turn.complete({
    turnId: 'heal-1',
    answer: 'done',
    durationMs: 5000,
    isAborted: false,
    reason: 'answer',
  })
  expect(store.state).toEqual({
    rotation: 1,
    lastPromptAt: 5000,
    history: [{ at: 5000, taken: false }],
  })

  await clock.advance(10 * 60 * 1000)
  await $.turn.start({ text: 'later', turnId: 'heal-2' })
  await clock.advance(5000)
  const second = await mountBand($)
  expect((await second.find({ text: NUDGE }))?.text).toContain('20-20-20: look at something about 20 feet away for 20 seconds')
  await second.unmount()
  expect(writes.count).toBe(3)
})

test(
  'a stored history that is not an array is replaced the next time a nudge is due',
  SHORT_FUSE,
  async ($, on) => {
    // rotation 3 would be "stand up and stretch" if the bad record were trusted.
    // It is not: the nudge starts fresh, and the bad value does not stay.
    const seed = { rotation: 3, lastPromptAt: null, history: { not: 'a list' } }
    const { clock, store, writes } = wire(on, { seed })
    await $.turn.start({ text: 'long', turnId: 'bad-history' })
    await clock.advance(5000)
    const band = await mountBand($)
    expect((await band.find({ text: NUDGE }))?.text).toContain('posture check: reset how you are sitting')
    await band.unmount()
    expect(writes.count).toBe(1)
    expect(store.state).toEqual({ rotation: 1, lastPromptAt: 5000, history: [] })
  },
)
