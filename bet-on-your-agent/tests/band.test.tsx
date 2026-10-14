import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

/** The band is drawn on whatever surface the session has, not an assumed one. */
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

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

const PANE = {
  component: 'Pane',
  requestId: 'bet-on-your-agent',
  props: {
    title: 'Bet on your agent',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 100, rows: 30 },
} as const

/**
 * Nothing sits beneath the plugins in a test, so the test answers for the
 * engine — including the band itself, which the mod draws nothing into when it
 * has nothing to ask.
 */
const engineBottom = (on: On) => {
  // The clock a record is stamped with, and the store it is kept in.
  mock.clock(on)
  mock.store(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}

test('one question at a time, each answered by a bare digit', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'add the retry logic to the client', turnId: 'turn-1' })

  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })

  // The ask is quoted, so the forecast is anchored to something.
  expect(await ui.find({ text: /add the retry logic/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(5)

  await ui.press({ key: 'p80' })

  // The confidence row is answered, so the band moves on rather than stacking.
  expect(await ui.find({ text: /how many files/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)

  await ui.press({ key: 'f2-3' })

  expect(await ui.find({ text: /bet 80% · 2-3 files/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

  await ui.unmount()
})

test('a bet placed while the turn runs is the verdict owed once it lands', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'refactor the auth layer', turnId: 'turn-2' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p95' })
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-2',
    answer: 'done',
    durationMs: 48000,
    isAborted: false,
    reason: 'answer',
  })

  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })

  expect(await idle.find({ text: /refactor the auth layer/ })).toBeDefined()
  expect(await idle.find({ text: /you said 95%/ })).toBeDefined()
  expect(await idle.findAll({ type: 'Button' })).toHaveLength(3)

  await idle.press({ key: 'fixed' })

  // Answered, so the band has nothing left to ask.
  expect(await idle.find({ text: /you said/ })).toBeUndefined()
  await idle.unmount()

  // And the call shows up in the record, scored and named.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /overconfident/ })).toBeDefined()
  expect(await pane.find({ text: /refactor the auth layer/ })).toBeDefined()
  await pane.unmount()
})

test('the verdict can be waved away, and then is not asked again', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'tidy the imports', turnId: 'turn-3' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p65' })
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-3',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  expect(await idle.find({ text: /tidy the imports/ })).toBeDefined()

  await idle.press({ key: 'skip' })

  expect(await idle.find({ text: /you said/ })).toBeUndefined()
  await idle.unmount()
})

test('the band yields to a survey of the engine’s own', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'anything', turnId: 'turn-4' })

  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: { ...bandProps(true), hasSurvey: true },
  })

  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

test('the record pane draws on every surface', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'bet-on-your-agent', surface, ...PANE })

    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })

    await ui.unmount()
  }
})
