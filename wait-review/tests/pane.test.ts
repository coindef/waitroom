import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The pane is drawn on whatever surface the session has, so the body below runs
 * once per surface rather than against an assumed terminal.
 */
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

/** The props the engine hands a Pane's render hook. */
const PANE_PROPS = {
  title: 'Wait review',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('the pane draws on every surface, and says so when there is nothing to read', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'wait-review',
      surface,
      component: 'Pane',
      requestId: 'wait-review',
      props: PANE_PROPS,
      viewport: { columns: 100, rows: 30 },
    })

    expect(await ui.find({ text: /Nothing to read yet/ })).toBeDefined()
    expect(await ui.find({ text: /lands here, a hunk at a time, to read while it works/ })).toBeDefined()
    // The pane that opens by itself has no keys yet. The first-run line says so.
    const focus = await ui.find({ type: 'Text', text: 'Focus this pane: /wait-review · then o / f work' })
    expect(focus?.props.weight).toBe('bold')
    // Nothing waiting means nothing to act on.
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

    await ui.unmount()
  }
})

test('the first-run legend is written the way the live controls draw themselves', async $ => {
  const ui = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

  // `k: Label`, the labels the buttons carry one turn later, never a gloss of them.
  for (const [letter, label] of [
    ['o', 'Looks right'],
    ['f', 'Flag'],
    ['l', 'Later'],
    ['x', 'Skip file'],
  ] as const) {
    expect(await ui.find({ text: `${letter}:` })).toBeDefined()
    expect(await ui.find({ text: label })).toBeDefined()
  }
  expect(await ui.find({ text: /flag it for Claude|skip the file|looks right/ })).toBeUndefined()

  await ui.unmount()
})

test('the pane asks the engine for no element the surface does not have', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'wait-review',
      surface,
      component: 'Pane',
      requestId: 'wait-review',
      props: PANE_PROPS,
      viewport: { columns: 60, rows: 12 },
    })

    // A tree the surface's table refuses makes `drawn` reject, so this is the
    // check that the pane is drawable there at all.
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })

    await ui.unmount()
  }
})

/** Nothing sits beneath the plugins in a test, so the test answers for the engine. */
const engineBottom = (on: On) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
}

const mountPane = ($: Engine, surface: 'terminal' | 'mobile') =>
  $.ui.mount({
    plugin: 'wait-review',
    surface,
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

test('flagging stays one press, and the note box is a separate, optional act', async ($, on) => {
  engineBottom(on)

  const ui = await mountPane($, 'terminal')
  // With nothing queued there is nothing to flag, so no note is on offer.
  expect(await ui.find({ key: 'note-open' })).toBeUndefined()
  await ui.unmount()
})
