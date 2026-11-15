import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * A failed or unreadable `$.store.get` must not be written back. These
 * tests are the inverse of that bug: the saved cooldown, rotation, and
 * history stay, and a raise that cannot read the cooldown shows nothing.
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

test('a stored value that is not an object is not overwritten', SHORT_FUSE, async ($, on) => {
  const { clock, store, writes } = wire(on, { seed: 'not-a-record' })
  await $.turn.start({ text: 'long', turnId: 'bad-object' })
  await clock.advance(5000)
  const band = await mountBand($)
  expect(await band.find({ text: NUDGE })).toBeUndefined()
  await band.unmount()
  expect(writes.count).toBe(0)
  expect(store.state).toBe('not-a-record')
})

test('a stored history that is not an array is not overwritten', SHORT_FUSE, async ($, on) => {
  const seed = { rotation: 3, lastPromptAt: null, history: { not: 'a list' } }
  const { clock, store, writes } = wire(on, { seed })
  await $.turn.start({ text: 'long', turnId: 'bad-history' })
  await clock.advance(5000)
  const band = await mountBand($)
  expect(await band.find({ text: NUDGE })).toBeUndefined()
  await band.unmount()
  expect(writes.count).toBe(0)
  expect(store.state).toEqual(seed)
})
