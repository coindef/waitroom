import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The whole loop, with git answered by the test: Claude writes a file, the turn
 * lands, the hunks queue, the person flags one and says why, and the note
 * reaches Claude with their next message.
 *
 * `$.process.run` is an event like any other, so the one path the unit tests
 * cannot reach — the scan — is driven here instead of mocked away.
 */

const ROOT = '/repo'

const DIFF = [
  'diff --git src/auth.ts src/auth.ts',
  'index 1234567..89abcde 100644',
  '--- src/auth.ts',
  '+++ src/auth.ts',
  '@@ -10,3 +10,3 @@ export const call = async (url: string) => {',
  '   const sent = await fetch(url)',
  '-  if (!sent.ok) return retry(url)',
  '+  if (!sent.ok) return undefined',
  '   return sent.json()',
  '',
].join('\n')

/** A `$` call is answered with `{ value }`, as the engine beneath would. */
const ran = (stdout: string) => ({
  value: {
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** Stands in for the engine, and for git. */
const engineBottom = (on: On) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran(`${ROOT}\n`)
    if (argv.includes('rev-parse')) return ran(`${BASE}\n`)
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes('diff')) return ran(DIFF)

    return ran('')
  })
}

const PANE_PROPS = {
  title: 'Wait review',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

test('a hunk Claude wrote is queued, flagged with a reason, and sent back', async ($, on) => {
  engineBottom(on)
  let attached: readonly string[] = []
  on('prompt.submit', ($$, e) => {
    attached = e.context ?? []

    return { text: e.text }
  })

  // Claude writes a file during a turn, and the turn lands.
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/auth.ts`, content: 'x' })
  await $.turn.complete({
    turnId: 'turn-1',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

  // The scan found the hunk and the pane is offering it.
  expect(await ui.find({ text: /src\/auth\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()

  // Flagging is one press, and only then is a reason on offer.
  expect(await ui.find({ key: 'note-open' })).toBeUndefined()
  await ui.press({ key: 'flag' })
  expect((await ui.find({ key: 'note-open' }))?.props.label).toBe('Say why')

  // The note box is a mode: while it is up, no review hotkey is drawn under it.
  await ui.press({ key: 'note-open' })
  expect(await ui.find({ key: 'ok' })).toBeUndefined()
  expect(await ui.find({ key: 'note-text' })).toBeDefined()
  await ui.input({ key: 'note-text', text: 'this drops the retry on every 5xx' })

  // Box closed; the offer stays, now naming the note it would revise.
  expect(await ui.find({ key: 'note-text' })).toBeUndefined()
  expect((await ui.find({ key: 'note-open' }))?.props.label).toBe('Edit note')
  await ui.unmount()

  // The payoff: the hunk and the reason reach Claude with the next message.
  await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })

  expect(attached).toHaveLength(1)
  expect(attached[0]).toContain('src/auth.ts')
  expect(attached[0]).toContain('they said: this drops the retry on every 5xx')
  expect(attached[0]).toContain('+  if (!sent.ok) return undefined')
})

test('an empty note box means the diff speaks for itself', async ($, on) => {
  engineBottom(on)
  let attached: readonly string[] = []
  on('prompt.submit', ($$, e) => {
    attached = e.context ?? []

    return { text: e.text }
  })

  await $.turn.start({ text: 'drop the retry', turnId: 'turn-2' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/auth.ts`, content: 'x' })
  await $.turn.complete({
    turnId: 'turn-2',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })
  await ui.press({ key: 'flag' })
  await ui.press({ key: 'note-open' })
  await ui.input({ key: 'note-text', text: '   ' })
  await ui.unmount()

  await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })

  expect(attached[0]).toContain('src/auth.ts')
  expect(attached[0]).not.toContain('they said')
})

test('a file the agent regenerates is never queued at all', async ($, on) => {
  engineBottom(on)

  await $.turn.start({ text: 'bump a dependency', turnId: 'turn-3' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/package-lock.json`, content: 'x' })
  await $.turn.complete({
    turnId: 'turn-3',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

  // git was never asked about it, so there is nothing to read.
  expect(await ui.find({ text: /Nothing written yet/ })).toBeDefined()
  await ui.unmount()
})

test('a surface with no field offers no note, and still reviews', async ($, on) => {
  engineBottom(on)

  await $.turn.start({ text: 'drop the retry', turnId: 'turn-4' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/auth.ts`, content: 'x' })
  await $.turn.complete({
    turnId: 'turn-4',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  // The mobile app draws no Input, so the note is not on offer there at all.
  const ui = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'mobile',
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 60, rows: 30 },
  })

  expect(await ui.find({ text: /src\/auth\.ts/ })).toBeDefined()
  await ui.press({ key: 'flag' })

  expect(await ui.find({ key: 'note-open' })).toBeUndefined()
  // Reviewing still works; only the reason is unavailable.
  expect(await ui.find({ text: /1 flagged/ })).toBeDefined()

  await ui.unmount()
})

test('a commit the agent makes mid-session does not empty the queue', async ($, on) => {
  // git as it behaves once the agent has committed its own work: there is
  // nothing against HEAD any more, but plenty against where the session began.
  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($$, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran(`${ROOT}\n`)
    if (argv.includes('rev-parse')) return ran(`${BASE}\n`)
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes(`diff ${BASE}`)) return ran(DIFF)
    // Against HEAD the committed work has vanished.
    if (argv.includes('diff')) return ran('')

    return ran('')
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-5' })
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/auth.ts`, content: 'x' })
  await $.turn.complete({
    turnId: 'turn-5',
    answer: 'committed it',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

  // A commit is not a review: the hunk is still waiting to be read.
  expect(await ui.find({ text: /src\/auth\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()

  await ui.unmount()
})
