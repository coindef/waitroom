import { expect, test } from 'claude-code/testing'

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

    expect(await ui.find({ text: /0 to read/ })).toBeDefined()
    expect(await ui.find({ text: /Hunks show up here/ })).toBeDefined()
    // Nothing waiting means nothing to act on.
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

    await ui.unmount()
  }
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
