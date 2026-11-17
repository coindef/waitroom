import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * A check that already fired when its turn ended. The timer is cancelled at
 * `turn.complete`, but a check it started may still be reading the store;
 * once the read comes back it must see that its turn is over and do nothing.
 */

const BAND = {
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 30 },
} as const

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
  $.ui.mount({ plugin: 'wait-breathe', surface: 'terminal', ...BAND, props: BAND_PROPS })

// The test runtime has timers; the mod's lib (es2023, no DOM) does not declare them.
declare const setTimeout: (callback: () => void, ms: number) => unknown

const NUDGE = /posture|20-20-20|4-4-4|stretch/

/** A store whose first read is held open until the test releases it. */
const holdingFirstRead = (on: On) => {
  const store: Record<string, unknown> = {}
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let reached: () => void = () => undefined
  const parked = new Promise<void>(resolve => {
    reached = resolve
  })
  let gets = 0
  const clock = mock.clock(on)
  on('store.get', async ($, e) => {
    gets += 1
    if (gets === 1) {
      reached()
      await held
    }
    const value = store[e.key]

    return { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }
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

  return { clock, store, release, parked }
}

test(
  'a check still reading the store when its turn ends raises nothing and spends no cooldown',
  { options: { enabled: true, longTurnSeconds: 5 } },
  async ($, on) => {
    // Fable 5.2 audit WB-1, the re-check half: the timer fires at 5s and its
    // check is parked inside its store read; the turn ends; then the read
    // comes back. Without the re-check the nudge was saved and drew again in
    // the next turn.
    const { clock, store, release, parked } = holdingFirstRead(on)
    await $.turn.start({ text: 'five seconds', turnId: 'ended' })
    const firing = clock.advance(5000)
    await parked
    await $.turn.complete({ turnId: 'ended', answer: 'done', durationMs: 5000, isAborted: false, reason: 'answer' })
    release()
    await firing
    // The check's own awaits finish on the host's schedule, not the mock clock's.
    await new Promise<void>(resolve => setTimeout(resolve, 20))

    await $.turn.start({ text: 'next', turnId: 'next' })
    const band = await mountBand($)
    const shown = (await band.find({ text: NUDGE }))?.text
    await band.unmount()
    expect({ shown: shown ?? null, saved: store.state ?? null }).toEqual({ shown: null, saved: null })
  },
)
