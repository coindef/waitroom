import { expect, test } from 'claude-code/testing'

/** The pane is drawn on whatever surface the session has, not an assumed one. */
const SURFACES = ['terminal', 'desktop', 'mobile'] as const

const PANE_PROPS = {
  title: 'Bet on your agent',
  isFocused: false,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('the pane draws on every surface, and invites a first bet when empty', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'bet-on-your-agent',
      surface,
      component: 'Pane',
      requestId: 'bet-on-your-agent',
      props: PANE_PROPS,
      viewport: { columns: 100, rows: 30 },
    })

    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
    // Nothing is running, so there is nothing to bet on yet.
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })

    await ui.unmount()
  }
})

test('the betting buttons appear once a turn is running', async ($, on) => {
  // Nothing sits beneath the plugins in a test, so the test answers for the
  // engine. The status line has no bottom here and the engine drops it, which
  // is harmless: the pane is what this test is about.
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'do the thing', turnId: 'turn-1' })

  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'bet-on-your-agent',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

  expect(await ui.find({ text: /Will it land first try/ })).toBeDefined()
  // Five confidence bands and four file buckets.
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(9)

  await ui.press({ key: 'p80' })
  expect(await ui.find({ text: /you said 80%/ })).toBeDefined()
  // The confidence row is answered, so only the file buttons are left.
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)

  await ui.unmount()
})
