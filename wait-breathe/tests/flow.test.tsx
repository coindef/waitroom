import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The whole loop through the engine: a timer armed at `turn.start`, fired by
 * the mock clock, read back from the band and from the session-end line.
 */

const BAND = {
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 30 },
} as const

const bandProps = (isWorking: boolean, hasSurvey = false) =>
  ({
    hasSurvey,
    isWorking,
    maxRows: 6,
    bodyColumns: 115,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  }) as const

const mountBand = ($: Engine, isWorking: boolean, hasSurvey = false) =>
  $.ui.mount({
    plugin: 'wait-breathe',
    surface: 'terminal',
    ...BAND,
    props: bandProps(isWorking, hasSurvey),
  })

const NUDGE = /posture|20-20-20|4-4-4|stretch/

/** Nothing sits beneath the plugin in a test, so the test stands in for the engine. */
const engineBottom = (on: On) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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

  return { clock, logged }
}

const SHORT_FUSE = { options: { enabled: true, longTurnSeconds: 5 } }

test('disabled, a long turn raises nothing and the session ends with no line', async ($, on) => {
  const { clock, logged } = engineBottom(on)
  // 90s is the default (enabled defaults to off regardless); well past it either way.
  await $.turn.start({ text: 'a long one', turnId: 'turn-1' })
  await clock.advance(5 * 60 * 1000)

  const band = await mountBand($, true)
  expect(await band.find({ text: NUDGE })).toBeUndefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()

  await $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(logged).toHaveLength(0)
})

test(
  'the threshold is a boundary: nothing just under it, the nudge right at it',
  SHORT_FUSE,
  async ($, on) => {
    const { clock } = engineBottom(on)
    await $.turn.start({ text: 'add a feature', turnId: 'turn-2' })

    await clock.advance(4999)
    const early = await mountBand($, true)
    expect(await early.find({ text: NUDGE })).toBeUndefined()
    await early.unmount()

    await clock.advance(1)
    const onTime = await mountBand($, true)
    expect(await onTime.find({ text: NUDGE })).toBeDefined()
    expect(await onTime.findAll({ type: 'Button' })).toHaveLength(1)
    await onTime.unmount()
  },
)

test(
  'one prompt is all a turn gets, however long it keeps running past the threshold',
  SHORT_FUSE,
  async ($, on) => {
    const { clock } = engineBottom(on)
    await $.turn.start({ text: 'a very long one', turnId: 'turn-3' })
    await clock.advance(5000)

    const first = await mountBand($, true)
    const firstText = (await first.find({ text: NUDGE }))?.text
    expect(firstText).toBeDefined()
    await first.unmount()

    // Ten times the threshold further into the same turn: still the one prompt.
    await clock.advance(50000)
    const later = await mountBand($, true)
    const laterText = (await later.find({ text: NUDGE }))?.text
    await later.unmount()

    expect(laterText).toBe(firstText)
  },
)

test(
  'a second long turn inside the ten-minute cooldown gets no nudge of its own',
  SHORT_FUSE,
  async ($, on) => {
    const { clock } = engineBottom(on)
    await $.turn.start({ text: 'first', turnId: 'turn-4a' })
    await clock.advance(5000)
    const first = await mountBand($, true)
    expect(await first.find({ text: NUDGE })).toBeDefined()
    await first.unmount()
    await $.turn.complete({ turnId: 'turn-4a', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer' })

    await $.turn.start({ text: 'second, soon after', turnId: 'turn-4b' })
    await clock.advance(5000)
    const second = await mountBand($, true)
    expect(await second.find({ text: NUDGE })).toBeUndefined()
    await second.unmount()
    await $.turn.complete({ turnId: 'turn-4b', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer' })

    // Past the ten minutes since the first nudge landed, a third long turn
    // gets one of its own: the wait happens before this turn starts, since
    // the one-shot timer fires at this turn's own threshold (5s in), not at
    // however far the clock is later advanced past that.
    await clock.advance(10 * 60 * 1000)
    await $.turn.start({ text: 'third, well after', turnId: 'turn-4c' })
    await clock.advance(5000)
    const third = await mountBand($, true)
    expect(await third.find({ text: NUDGE })).toBeDefined()
    await third.unmount()
  },
)

test('the band yields to a survey already up, same as the other mods', SHORT_FUSE, async ($, on) => {
  const { clock } = engineBottom(on)
  await $.turn.start({ text: 'anything', turnId: 'turn-5' })
  await clock.advance(5000)

  const band = await mountBand($, true, true)
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test(
  '"took it" hides the nudge for the rest of the turn and counts as taken',
  SHORT_FUSE,
  async ($, on) => {
    const { clock, logged } = engineBottom(on)
    await $.turn.start({ text: 'add a feature', turnId: 'turn-6' })
    await clock.advance(5000)

    const band = await mountBand($, true)
    await band.press({ key: 'taken' })
    expect(await band.find({ text: NUDGE })).toBeUndefined()
    await band.unmount()

    await $.turn.complete({ turnId: 'turn-6', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer' })
    await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)

    expect(logged.at(-1)).toBe('breathe: 1 prompt, 1 taken this session')
  },
)

test('a nudge left untaken still counts, as zero taken', SHORT_FUSE, async ($, on) => {
  const { clock, logged } = engineBottom(on)
  await $.turn.start({ text: 'add a feature', turnId: 'turn-7' })
  await clock.advance(5000)
  const band = await mountBand($, true)
  await band.unmount()
  await $.turn.complete({ turnId: 'turn-7', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer' })

  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)

  expect(logged.at(-1)).toBe('breathe: 1 prompt, 0 taken this session')
})

test('a session with no long turn at all ends with no line', { options: { enabled: true } }, async ($, on) => {
  const { logged } = engineBottom(on)
  await $.turn.start({ text: 'quick fix', turnId: 'turn-8' })
  await $.turn.complete({ turnId: 'turn-8', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)

  expect(logged).toHaveLength(0)
})
