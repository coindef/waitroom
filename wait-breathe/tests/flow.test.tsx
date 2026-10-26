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

/** What the `/config` menu would answer, and every write the plugin asked of it. */
type Settings = { refuse?: string; set: { key: string; value: unknown }[] }

/** Nothing sits beneath the plugin in a test, so the test stands in for the engine. */
const engineBottom = (on: On, settings: Settings = { set: [] }) => {
  const clock = mock.clock(on)
  mock.store(on)
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
  on('config.list', () => ({
    value: [
      {
        key: 'wait-breathe.enabled',
        label: 'Enable the breathing nudges',
        kind: 'boolean',
        value: false,
        provider: { plugin: 'wait-breathe', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    if (settings.refuse !== undefined) return { deny: settings.refuse }
    settings.set.push({ key: e.key, value: e.value })

    return { value: e.value }
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

type Node = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

/** The Box directly holding the first child that `holds` matches, read off the tree as drawn. */
const parentOf = (tree: unknown, holds: (child: Node) => boolean): Node | undefined => {
  const node = tree as Node
  const kids = (Array.isArray(node?.children) ? node.children : []) as Node[]
  if (node?.type === 'Box' && kids.some(holds)) return node
  for (const kid of kids) {
    const found = parentOf(kid, holds)
    if (found) return found
  }

  return undefined
}

const textOf = (node: Node): string =>
  (Array.isArray(node?.children) ? node.children : [])
    .map(kid => (typeof kid === 'string' ? kid : textOf(kid as Node)))
    .join('')

test(
  'in a 60-column terminal the message is what gets cut: the tag and the key keep their width',
  SHORT_FUSE,
  async ($, on) => {
    const { clock } = engineBottom(on)
    await $.turn.start({ text: 'a long one', turnId: 'turn-narrow' })
    await clock.advance(5000)

    const band = await $.ui.mount({
      plugin: 'wait-breathe',
      surface: 'terminal',
      ...BAND,
      viewport: { columns: 60, rows: 30 },
      props: { ...bandProps(true), bodyColumns: 55 },
    })
    const drawn = await band.drawn()
    // Shrunk to fit, " breathe " and "b: Took it" each wrapped onto a second
    // line in their own narrowed column, beside the message's first.
    const tag = parentOf(drawn, kid => kid.type === 'Text' && textOf(kid) === ' breathe ')
    const key = parentOf(drawn, kid => kid.type === 'Button')
    expect(tag?.props?.flexShrink).toBe(0)
    expect(key?.props?.flexShrink).toBe(0)
    const message = parentOf(drawn, kid => kid.type === 'Text' && NUDGE.test(textOf(kid)))
    const messageText = (message?.children as Node[] | undefined)?.find(kid => NUDGE.test(textOf(kid)))
    expect(messageText?.props?.wrap).toBe('truncate-end')
    await band.unmount()
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

test('/breathe turns the nudges on from the default off, in the setting the install screen shows', async ($, on) => {
  const settings: Settings = { set: [] }
  const { clock } = engineBottom(on, settings)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const reply = await $.command.run({ command: 'breathe' } as never)

  expect(reply.text).toContain('breathe: on')
  expect(reply.text).toContain('90s')
  expect(reply.text).toContain('/breathe again turns it off')
  // One switch, not two: the same `enabled` field `/plugin` and the install screen show.
  expect(settings.set).toEqual([{ key: 'wait-breathe.enabled', value: true }])

  // And it holds from the next turn: one quiet nudge at the default 90s.
  await $.turn.start({ text: 'a long one', turnId: 'turn-t1' })
  await clock.advance(90 * 1000)
  const band = await mountBand($, true)
  expect(await band.find({ text: NUDGE })).toBeDefined()
  await band.unmount()
})

test('/breathe turns them off again when on, and a long turn is quiet after', SHORT_FUSE, async ($, on) => {
  const settings: Settings = { set: [] }
  const { clock } = engineBottom(on, settings)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const reply = await $.command.run({ command: 'breathe' } as never)

  expect(reply.text).toContain('breathe: off')
  expect(reply.text).toContain('/breathe turns it on')
  expect(settings.set).toEqual([{ key: 'wait-breathe.enabled', value: false }])

  await $.turn.start({ text: 'a long one', turnId: 'turn-t2' })
  await clock.advance(60 * 1000)
  const band = await mountBand($, true)
  expect(await band.find({ text: NUDGE })).toBeUndefined()
  await band.unmount()
})

test('a toggle the settings refuse changes nothing, and says so', async ($, on) => {
  const settings: Settings = { refuse: 'a managed setting owns it', set: [] }
  const { clock } = engineBottom(on, settings)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const reply = await $.command.run({ command: 'breathe' } as never)

  expect(reply.text).toContain('breathe: still off')
  expect(reply.text).toContain('a managed setting owns it')
  await $.turn.start({ text: 'a long one', turnId: 'turn-t3' })
  await clock.advance(5 * 60 * 1000)
  const band = await mountBand($, true)
  expect(await band.find({ text: NUDGE })).toBeUndefined()
  await band.unmount()
})

/*
 * The row above the prompt is shared with wait-ship and bet-on-your-agent,
 * and the nudge comes first in it. Each stand-in below loads beneath this
 * mod (`append`) under the real mod's name, which is what the engine stamps
 * on its row. An inline plugin closes over nothing of this file.
 */

test(
  'a due nudge takes the row from a bet question beneath it, without stacking the two',
  {
    options: { enabled: true, longTurnSeconds: 5 },
    plugins: [
      {
        name: 'bet-on-your-agent',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box flexDirection="column">
                <Text>bet: Will it land first try?</Text>
                <Button key="p80" hotkey="3" plain onPress={() => undefined}>
                  80%
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    const { clock } = engineBottom(on)
    await $.turn.start({ text: 'a long one', turnId: 'turn-p1' })

    // Before the threshold the bet's question has the row, untouched.
    const early = await mountBand($, true)
    expect(await early.find({ text: /Will it land first try\?/ })).toBeDefined()
    await early.unmount()

    await clock.advance(5000)
    const due = await mountBand($, true)
    expect(await due.find({ text: NUDGE })).toBeDefined()
    expect(await due.find({ text: /Will it land/ })).toBeUndefined()
    expect((await due.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['taken'])

    // Taken, the nudge steps aside and the question it waited in front of is back.
    await due.press({ key: 'taken' })
    expect(await due.find({ text: /Will it land first try\?/ })).toBeDefined()
    await due.unmount()
  },
)

test(
  'a due nudge takes the row from a ship offer beneath it, too',
  {
    options: { enabled: true, longTurnSeconds: 5 },
    plugins: [
      {
        name: 'wait-ship',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box flexDirection="column">
                <Text>ship: Drafts ready</Text>
                <Button key="all" hotkey="a" plain onPress={() => undefined}>
                  Accept all
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    const { clock } = engineBottom(on)
    await $.turn.start({ text: 'a long one', turnId: 'turn-p2' })
    await clock.advance(5000)

    const band = await mountBand($, true)
    expect(await band.find({ text: NUDGE })).toBeDefined()
    expect(await band.find({ text: /Drafts ready/ })).toBeUndefined()
    expect(await band.find({ key: 'all' })).toBeUndefined()
    await band.unmount()
  },
)
