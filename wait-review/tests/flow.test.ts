import type { On, RenderSurface } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The whole loop, with git answered by the test.
 *
 * `$.process.run` is an event like any other, so the one path no unit test can
 * reach — the scan — is driven here rather than mocked away.
 */

const ROOT = '/repo'
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const AUTH_DIFF = [
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

const LOCK_DIFF = [
  'diff --git package-lock.json package-lock.json',
  '--- package-lock.json',
  '+++ package-lock.json',
  '@@ -1,3 +1,3 @@',
  '   "name": "app",',
  '-  "version": "1.0.0",',
  '+  "version": "1.0.1",',
  '   "lockfileVersion": 3',
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

/** What git says right now; a test moves it to stand for work happening. */
type Repo = { vsBase: string; vsHead: string; revParses: number }

/** Stands in for the engine, and for git. */
const engineBottom = (on: On, repo: Repo) => {
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran(`${ROOT}\n`)
    if (argv.includes('rev-parse')) {
      repo.revParses++

      return ran(`${BASE}\n`)
    }
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes(`diff ${BASE}`)) return ran(repo.vsBase)
    if (argv.includes('diff HEAD')) return ran(repo.vsHead)

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

/** Generic in the surface, so `Mounted` offers only the acts that surface has. */
const mountPane = <P extends RenderSurface>($: Engine, surface: P) =>
  $.ui.mount({
    plugin: 'wait-review',
    surface,
    component: 'Pane',
    requestId: 'wait-review',
    props: PANE_PROPS,
    viewport: { columns: 100, rows: 30 },
  })

test('a file written with no Edit or Write call is still queued', async ($, on) => {
  // The bug this guards: the queue used to be built from Edit/Write calls, so
  // an agent that writes through a shell heredoc was invisible and nothing was
  // ever offered for review. No tool call is made anywhere in this test.
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-1' })
  await $.turn.complete({
    turnId: 'turn-1',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /src\/auth\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()

  // Every control carries its own key, so the pane teaches the keyboard
  // instead of needing a legend.
  const controls = await ui.findAll({ type: 'Button' })
  expect(controls.map(one => one.props.hotkey)).toEqual(['o', 'f', 'l', 'x'])
  expect(controls.every(one => one.props.plain === true)).toBe(true)

  await ui.unmount()
})

test('work already uncommitted when the session began is never queued', async ($, on) => {
  // Your own work in progress is not a review the agent owes you.
  const repo: Repo = { vsBase: AUTH_DIFF, vsHead: AUTH_DIFF, revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'look at something', turnId: 'turn-2' })
  await $.turn.complete({
    turnId: 'turn-2',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Nothing to read yet/ })).toBeDefined()
  await ui.unmount()
})

test('a commit the agent makes mid-session does not empty the queue', async ($, on) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  // The agent writes and then commits its own work: nothing against HEAD any
  // more, plenty against where the session began.
  repo.vsBase = AUTH_DIFF
  repo.vsHead = ''
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-3' })
  await $.turn.complete({
    turnId: 'turn-3',
    answer: 'committed it',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  // A commit is not a review.
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()
  await ui.unmount()
})

test('a hot reload re-anchors nothing and re-snapshots nothing', async ($, on) => {
  // session.start fires again on every reload while $.state survives it, so
  // re-taking either would move the base onto a commit made since, or file the
  // agent's own work as pre-existing and empty the queue.
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(repo.revParses).toBe(1)

  await $.turn.start({ text: 'drop the retry', turnId: 'turn-4' })
  await $.turn.complete({
    turnId: 'turn-4',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()
  await ui.unmount()
})

test('a file the agent regenerates is never queued at all', async ($, on) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  repo.vsBase = LOCK_DIFF
  repo.vsHead = LOCK_DIFF
  await $.turn.start({ text: 'bump a dependency', turnId: 'turn-5' })
  await $.turn.complete({
    turnId: 'turn-5',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Nothing to read yet/ })).toBeDefined()
  await ui.unmount()
})

test('a hunk is flagged with a reason, and the reason reaches Claude', async ($, on) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)
  let attached: readonly string[] = []
  on('prompt.submit', ($$, e) => {
    attached = e.context ?? []

    return { text: e.text }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-6' })
  await $.turn.complete({
    turnId: 'turn-6',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')

  // Flagging is one press, and only then is a reason on offer.
  expect(await ui.find({ key: 'note-open' })).toBeUndefined()
  await ui.press({ key: 'flag' })
  expect((await ui.find({ key: 'note-open' }))?.props.label).toBe('Say why')

  // The note box is a mode: while it is up, no review hotkey is drawn under it.
  await ui.press({ key: 'note-open' })
  expect(await ui.find({ key: 'ok' })).toBeUndefined()
  await ui.input({ key: 'note-text', text: 'this drops the retry on every 5xx' })

  expect(await ui.find({ key: 'note-text' })).toBeUndefined()
  expect((await ui.find({ key: 'note-open' }))?.props.label).toBe('Edit note')
  await ui.unmount()

  await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })

  expect(attached).toHaveLength(1)
  expect(attached[0]).toContain('src/auth.ts')
  expect(attached[0]).toContain('they said: this drops the retry on every 5xx')
  expect(attached[0]).toContain('+  if (!sent.ok) return undefined')
})

test('an empty note box means the diff speaks for itself', async ($, on) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)
  let attached: readonly string[] = []
  on('prompt.submit', ($$, e) => {
    attached = e.context ?? []

    return { text: e.text }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-7' })
  await $.turn.complete({
    turnId: 'turn-7',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'flag' })
  await ui.press({ key: 'note-open' })
  await ui.input({ key: 'note-text', text: '   ' })
  await ui.unmount()

  await $.prompt.submit({ text: 'carry on', wait: false, origin: { kind: 'composer' } })

  expect(attached[0]).toContain('src/auth.ts')
  expect(attached[0]).not.toContain('they said')
})

test('a surface with no field offers no note, and still reviews', async ($, on) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'mobile', isInteractive: true })
  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-8' })
  await $.turn.complete({
    turnId: 'turn-8',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'mobile')
  expect(await ui.find({ text: /src\/auth\.ts/ })).toBeDefined()
  await ui.press({ key: 'flag' })

  // The mobile app draws no Input, so the reason is not on offer there.
  expect(await ui.find({ key: 'note-open' })).toBeUndefined()
  expect(await ui.find({ text: /1 flagged/ })).toBeDefined()
  await ui.unmount()
})

test('dropping a file can be undone, same as marking a single hunk', async ($, on) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-10' })
  await $.turn.complete({
    turnId: 'turn-10',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()

  await ui.press({ key: 'drop' })
  expect(await ui.find({ text: /1 skipped/ })).toBeDefined()

  // Skipping a whole file touches the most hunks of any call, so it is the
  // one most worth being able to take back.
  await ui.press({ key: 'undo' })
  expect(await ui.find({ text: /1 to read/ })).toBeDefined()
  expect(await ui.find({ text: /skipped/ })).toBeUndefined()
  await ui.unmount()
})

test('the full review card is drawable on every surface', async ($, on) => {
  // `drawn` rejects when a surface could not draw what the chain returned, so
  // this is the check that the card's layout validates against each surface's
  // own element table — not just the empty state.
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = AUTH_DIFF
  repo.vsHead = AUTH_DIFF
  await $.turn.start({ text: 'drop the retry', turnId: 'turn-9' })
  await $.turn.complete({
    turnId: 'turn-9',
    answer: 'done',
    durationMs: 30000,
    isAborted: false,
    reason: 'answer',
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await mountPane($, surface)

    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    // The diff itself is drawn as a diff, not as plain text.
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ text: /line 10/ })).toBeDefined()

    await ui.unmount()
  }
})
