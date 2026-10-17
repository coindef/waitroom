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

/** A new file as git diffs it: one hunk as long as the file. */
const NEW_FILE_DIFF = [
  'diff --git src/big.ts src/big.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ src/big.ts',
  '@@ -0,0 +1,80 @@',
  ...Array.from({ length: 80 }, (_, at) => `+export const line${at + 1} = ${at + 1}`),
  '',
].join('\n')

const queueOne = async ($: Engine, on: On, diff: string, turnId: string) => {
  const repo: Repo = { vsBase: '', vsHead: '', revParses: 0 }
  engineBottom(on, repo)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = diff
  repo.vsHead = diff
  await $.turn.start({ text: 'write it', turnId })
  await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
}

test('a new file longer than the pane is read page by page, to its end', async ($, on) => {
  await queueOne($, on, NEW_FILE_DIFF, 'turn-p1')
  const ui = await mountPane($, 'terminal')

  // The pane holds 30 rows, so the 80-line file cannot be shown at once.
  expect(await ui.find({ text: /lines 1–\d+ of 80/ })).toBeDefined()
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  // `line1 = 1` and not `line10 = 10`: the lookahead refuses a following digit.
  const firstLine = /line1 = 1(?!\d)/
  expect(await ui.find({ text: firstLine })).toBeDefined()

  await ui.press({ key: 'more' })
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ text: firstLine })).toBeUndefined()

  // And back again lands on the first page.
  await ui.press({ key: 'back' })
  expect(await ui.find({ text: firstLine })).toBeDefined()
  await ui.press({ key: 'more' })

  // Paging all the way reaches the last line, and then there is no more.
  for (let at = 0; at < 10 && (await ui.find({ key: 'more' })); at++) await ui.press({ key: 'more' })
  expect(await ui.find({ text: /line80 = 80/ })).toBeDefined()
  expect(await ui.find({ text: /of 80/ })).toBeDefined()

  // Reading the whole thing is not required before deciding on it.
  await ui.press({ key: 'ok' })
  expect(await ui.find({ text: /Diff read/ })).toBeDefined()
  await ui.unmount()
})

test('a short hunk shows no paging at all', async ($, on) => {
  await queueOne($, on, AUTH_DIFF, 'turn-p2')
  const ui = await mountPane($, 'terminal')

  expect(await ui.find({ key: 'more' })).toBeUndefined()
  expect(await ui.find({ text: /lines \d+–/ })).toBeUndefined()
  await ui.unmount()
})

test('the pane says how to give it the keys, and how to hand them back', async ($, on) => {
  await queueOne($, on, AUTH_DIFF, 'turn-p3')

  // Unfocused, `o` would type into the prompt, so the pane says what to do.
  const away = await $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: { ...PANE_PROPS, isFocused: false },
    viewport: { columns: 100, rows: 30 },
  })
  expect(await away.find({ text: /ctrl\+x tab to use these keys/ })).toBeDefined()
  await away.unmount()

  const here = await mountPane($, 'terminal')
  expect(await here.find({ text: /esc hands the keys back/ })).toBeDefined()
  expect(await here.find({ text: /ctrl\+x tab/ })).toBeUndefined()
  await here.unmount()
})

test('the status line names the count and the way in, not the plugin again', async ($, on) => {
  const said: (string | undefined)[] = []
  on('ui.status', ($$, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  // No pane is placed in a test, as on a terminal under 144 columns.
  await queueOne($, on, AUTH_DIFF, 'turn-s1')

  expect(said.at(-1)).toBe('1 to read · open with /wait-review')
  expect(said.every(text => text === undefined || !text.startsWith('review'))).toBe(true)
})

test('a long changed line reaches the drawing whole, wrapped rather than cut', async ($, on) => {
  // Found in a live session: the pane cut `AbortSignal.timeout(10_0…` at its
  // edge, hiding exactly the change being reviewed.
  const LONG = [
    'diff --git src/client.ts src/client.ts',
    '--- src/client.ts',
    '+++ src/client.ts',
    '@@ -4,1 +4,1 @@',
    '-  const sent = await fetch(url)',
    '+  const sent = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } })',
    '',
  ].join('\n')
  await queueOne($, on, LONG, 'turn-w1')
  const ui = await mountPane($, 'terminal')

  const code = await ui.find({ type: 'Code' })
  expect(code?.props.wrap).toBe('wrap')
  expect(String(code?.props.source)).toContain('timeout(10_000), headers: { accept: "application/json" } })')
  await ui.unmount()
})

test('a page is sized to the pane body, not to the whole terminal', async ($, on) => {
  // Found live: pages were sized to the terminal's rows, but the prompt and
  // status rows sit below the pane, so a long hunk's first page pushed the
  // controls off the bottom.
  await queueOne($, on, NEW_FILE_DIFF, 'turn-h1')
  const shownAt = async (bodyRows: number) => {
    const ui = await $.ui.mount({
      plugin: 'wait-review',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'wait-review',
      props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows } },
      // The terminal is the same height both times; only the pane differs.
      viewport: { columns: 100, rows: 50 },
    })
    const label = String((await ui.find({ text: /lines 1–\d+ of 80/ }))?.text ?? '')
    await ui.unmount()

    return Number(/1–(\d+)/.exec(label)?.[1] ?? 0)
  }

  const short = await shownAt(24)
  const tall = await shownAt(44)

  expect(short).toBeGreaterThan(0)
  expect(tall - short).toBe(20)
  // The card's own chrome leaves room for the controls in a 24-row pane.
  expect(short).toBeLessThanOrEqual(24 - 10)
})
