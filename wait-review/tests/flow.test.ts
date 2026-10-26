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
  const clock = mock.clock(on)
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

  return clock
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
  // Flagging moved the card on, so the box shows the hunk it asks about.
  // Found recording the demo: the reason was typed under an empty pane.
  expect(await ui.find({ type: 'Code', text: /return undefined/ })).toBeDefined()
  await ui.input({ key: 'note-text', text: 'this drops the retry on every 5xx' })

  expect(await ui.find({ key: 'note-text' })).toBeUndefined()
  expect((await ui.find({ key: 'note-open' }))?.props.label).toBe('Edit the reason')
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
    expect(await ui.find({ text: /:10/ })).toBeDefined()

    await ui.unmount()
  }
})

test('untracked files nobody reviews do not crowd a real one out of the scan budget', async ($, on) => {
  // The untracked scan is capped (one git process per file), so an ignored
  // folder with more untracked files in it than the cap must not spend the
  // whole budget before the scan ever reaches a file worth reviewing.
  const REAL = 'src/new-feature.ts'
  const NEW_FILE_DIFF = [
    'diff --git /dev/null src/new-feature.ts',
    '--- /dev/null',
    '+++ src/new-feature.ts',
    '@@ -0,0 +1,1 @@',
    '+export const x = 1',
    '',
  ].join('\n')
  // Alphabetically first, the way git actually lists untracked paths, and
  // past the cap, so the old, unfiltered slice would never reach REAL.
  const junk = Array.from({ length: 45 }, (_, at) => `build/junk${String(at).padStart(2, '0')}.js`)
  // Written only once the turn runs, so the session-start snapshot (taken
  // before either file exists) does not file REAL as the person's own work.
  let written = false

  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($$, e) => ({ text: e.answer }))
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran(`${ROOT}\n`)
    if (argv.includes('rev-parse')) return ran(`${BASE}\n`)
    if (argv.includes('ls-files')) return ran(written ? [...junk, REAL].join('\n') : '')
    if (argv.includes(`--no-index -- /dev/null ${REAL}`)) return ran(NEW_FILE_DIFF)

    return ran('')
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  written = true
  await $.turn.start({ text: 'add a feature', turnId: 'turn-10' })
  await $.turn.complete({
    turnId: 'turn-10',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /src\/new-feature\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('a scan truncated by the untracked cap says so, quietly, in the pane and the command', async ($, on) => {
  // 45 reviewable untracked files, 5 past UNTRACKED_LIMIT (40): the scan
  // cannot reach all of them, and silently showing only part of the queue
  // would read as "fully read" when it was not.
  const files = Array.from({ length: 45 }, (_, at) => `src/new${String(at).padStart(2, '0')}.ts`)

  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($$, e) => ({ text: e.answer }))
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran(`${ROOT}\n`)
    if (argv.includes('rev-parse')) return ran(`${BASE}\n`)
    if (argv.includes('ls-files')) return ran(files.join('\n'))

    return ran('')
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add many files', turnId: 'turn-11' })
  await $.turn.complete({
    turnId: 'turn-11',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /\+5 more files not shown/ })).toBeDefined()
  await ui.unmount()

  const result = await $.command.run({ command: 'wait-review' } as never)
  expect(result.text).toContain('+5 more files not shown')
})

test('a repository with no commits still snapshots what was already there', async ($, on) => {
  // The bug this guards: beginSession used to return early when there was no
  // HEAD to anchor to, so the preexisting snapshot was never taken, and every
  // file already uncommitted before the agent touched anything — the
  // person's own work in progress — was offered as if it were the agent's.
  const NOTES_DIFF = [
    'diff --git /dev/null notes.md',
    '--- /dev/null',
    '+++ notes.md',
    '@@ -0,0 +1,1 @@',
    '+scratch',
    '',
  ].join('\n')
  const FEATURE_DIFF = [
    'diff --git /dev/null src/feature.ts',
    '--- /dev/null',
    '+++ src/feature.ts',
    '@@ -0,0 +1,1 @@',
    '+export const x = 1',
    '',
  ].join('\n')
  let written = false

  mock.clock(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($$, e) => ({ text: e.answer }))
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran(`${ROOT}\n`)
    // A repository with no commits yet: `rev-parse HEAD` fails.
    if (argv.includes('rev-parse')) {
      return {
        value: {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: ambiguous argument 'HEAD'",
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }
    if (argv.includes('ls-files')) return ran(written ? 'notes.md\nsrc/feature.ts' : 'notes.md')
    if (argv.includes('--no-index -- /dev/null notes.md')) return ran(NOTES_DIFF)
    if (argv.includes('--no-index -- /dev/null src/feature.ts')) return ran(FEATURE_DIFF)

    return ran('')
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  written = true
  await $.turn.start({ text: 'add a feature', turnId: 'turn-12' })
  await $.turn.complete({
    turnId: 'turn-12',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /src\/feature\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /notes\.md/ })).toBeUndefined()
  await ui.unmount()
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
  const clock = engineBottom(on, repo)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  repo.vsBase = diff
  repo.vsHead = diff
  await $.turn.start({ text: 'write it', turnId })
  await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

  return clock
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
  expect(await ui.find({ text: /All caught up/ })).toBeDefined()
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
  expect(await away.find({ text: /\/wait-review or ctrl\+x tab to use these keys/ })).toBeDefined()
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

test('a pane covered by the diff panel says how to uncover it', async ($, on) => {
  // Found live on 2.1.304: its diff panel opens beside the transcript when
  // Claude edits and covers this pane, and /wait-review answered 'Review pane
  // open.' The pane list still calls the pane shown then; only the focus that
  // /wait-review asks for fails to arrive.
  on('ui.panes', () => ({
    value: [{ id: 'wait-review', title: 'Wait review', isPlaced: true, isShown: true, isFocused: false }],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = await queueOne($, on, AUTH_DIFF, 'turn-c1')

  const replying = $.command.run({ command: 'wait-review', args: '' } as never)
  await clock.advance(1000)
  expect(JSON.stringify(await replying)).toContain('/diff hides that')
})

test('focus that arrives a moment late is not mistaken for a covered pane', async ($, on) => {
  // Found live, recording the demo: the pane list says unfocused at once and
  // focused 100-400ms later, so one look said the diff panel was in front of a
  // pane that was plainly on screen.
  let looks = 0
  on('ui.panes', () => {
    looks++

    return { value: [{ id: 'wait-review', title: 'Wait review', isPlaced: true, isShown: true, isFocused: looks >= 3 }] }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const clock = await queueOne($, on, AUTH_DIFF, 'turn-c2')

  const replying = $.command.run({ command: 'wait-review', args: '' } as never)
  await clock.advance(1000)
  const reply = JSON.stringify(await replying)
  expect(reply).toContain('Review pane open.')
  expect(reply).not.toContain('/diff')
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
  // The card's own chrome (nine rows: header, path, rule, paging, controls,
  // hint and the gaps) leaves room for the controls in a 24-row pane.
  expect(short).toBeLessThanOrEqual(24 - 9)
})

/** Four files, each a single hunk, so a combo can run past three and a skip can break it. */
const FOUR_HUNKS_DIFF = ['a', 'b', 'c', 'd']
  .map(name =>
    [
      `diff --git ${name}.ts ${name}.ts`,
      `--- ${name}.ts`,
      `+++ ${name}.ts`,
      '@@ -1,1 +1,1 @@',
      `-old ${name}`,
      `+new ${name}`,
      '',
    ].join('\n'),
  )
  .join('\n')

/**
 * Catches what the mod writes to the transcript, and answers for the engine's
 * own end step, so a test can end the session and read what it said there.
 */
const transcript = (on: On) => {
  const logged: string[] = []
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })

  return logged
}

const endSession = ($: Engine) =>
  $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } } as never)

/** Anything that would be the combo or the grade, live badge or summary alike. */
const SCORE = /combo|grade|Session:/

test('the pane shows no combo and no grade while a hunk is up, and one line of both once caught up', async ($, on) => {
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-combo')
  const ui = await mountPane($, 'terminal')

  // The header used to grow a `combo x3` badge at the third hunk in a row and
  // a grade line under it; both now wait until the reading is done.
  expect(await ui.find({ text: SCORE })).toBeUndefined()
  await ui.press({ key: 'ok' }) // a.ts
  await ui.press({ key: 'ok' }) // b.ts
  expect(await ui.find({ text: SCORE })).toBeUndefined()
  await ui.press({ key: 'ok' }) // c.ts: the third in a row
  expect(await ui.find({ text: SCORE })).toBeUndefined()

  // Caught up, the reading is done for now: its one line shows on the card,
  // since the line `session.end` writes is never on screen once it closes.
  await ui.press({ key: 'drop' }) // skips the last file, d.ts, in bulk
  expect(await ui.find({ text: /All caught up/ })).toBeDefined()
  expect(
    await ui.find({ text: 'Session: 3 read · 0 flagged · 1 skipped · longest combo 3 — grade A.' }),
  ).toBeDefined()
  expect(await ui.find({ text: /combo x/ })).toBeUndefined()

  await ui.unmount()
})

test('a fresh pane with nothing read yet shows no session line, caught up or not', async ($, on) => {
  await queueOne($, on, '', 'turn-fresh')
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Nothing to read yet/ })).toBeDefined()
  expect(await ui.find({ text: SCORE })).toBeUndefined()
  await ui.unmount()
})

test('the /wait-review reply carries the counts and no grade or combo', async ($, on) => {
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-reply')
  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'ok' })
  await ui.press({ key: 'ok' })
  await ui.press({ key: 'ok' })
  await ui.press({ key: 'drop' })
  await ui.unmount()

  const reply = await $.command.run({ command: 'wait-review', args: '' } as never)
  expect(reply.text).toContain('0 hunks to read, 3 reviewed, 0 flagged.')
  expect(reply.text).not.toMatch(SCORE)
})

test('a skip breaks the combo, and the session ends with one line of the reading and its grade', async ($, on) => {
  const logged = transcript(on)
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-grade')
  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'ok' }) // a.ts
  await ui.press({ key: 'flag' }) // b.ts: two in a row
  await ui.press({ key: 'drop' }) // skips c.ts in bulk, breaking the run
  await ui.press({ key: 'ok' }) // d.ts starts a new one
  await ui.unmount()

  // Nothing is said while the session runs, only once it ends.
  expect(logged).toHaveLength(0)
  await endSession($)

  // 3 read, 1 skipped: 75% acted on — grade A, since S needs 90%. The run
  // the skip broke was two long; without the break it would read three.
  expect(logged).toEqual(['Session: 3 read · 1 flagged · 1 skipped · longest combo 2 — grade A.'])
})

test('undo reverts the combo a skip broke, and the session-end line shows the run whole', async ($, on) => {
  const logged = transcript(on)
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-undo')
  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'ok' }) // a.ts
  await ui.press({ key: 'ok' }) // b.ts
  await ui.press({ key: 'drop' }) // skips c.ts, breaking a run of two
  await ui.press({ key: 'undo' }) // c.ts is back, and so is the run
  await ui.press({ key: 'ok' }) // c.ts
  await ui.press({ key: 'ok' }) // d.ts
  await ui.unmount()
  await endSession($)

  // An undo left un-reverted would read `1 skipped · longest combo 2` here.
  expect(logged).toEqual(['Session: 4 read · 0 flagged · 0 skipped · longest combo 4 — grade A.'])
})

test('a session with no review activity ends with no line', async ($, on) => {
  const logged = transcript(on)
  // Hunks are waiting, but none was read or skipped: a zero says nothing.
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-idle')
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /4 to read/ })).toBeDefined()
  await ui.unmount()

  await endSession($)

  expect(logged).toHaveLength(0)
})

/*
 * A 60-column terminal: no dock below 110, so the pane sits inline above the
 * prompt with 56 columns inside its frame. Squeezed to fit, every part of a
 * row shrank alike, and the parts that cannot be cut wrapped instead: the
 * tag split " wait-revi" / "ew", the bar broke over two lines, and the path's
 * counts wrapped "file 1 of" / "2" into a column of their own.
 */

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const kidsOf = (node: Node): Node[] => (Array.isArray(node?.children) ? (node.children as Node[]) : [])

const textOf = (node: Node): string =>
  kidsOf(node)
    .map(kid => (typeof kid === 'string' ? kid : textOf(kid)))
    .join('')

/** The Box directly holding the first child `holds` matches, read off the tree as drawn. */
const parentOf = (tree: unknown, holds: (child: Node) => boolean): Node | undefined => {
  const node = tree as Node
  if (node?.type === 'Box' && kidsOf(node).some(holds)) return node
  for (const kid of kidsOf(node)) {
    const found = parentOf(kid, holds)
    if (found) return found
  }

  return undefined
}

/** A child that is a Text whose whole text `matches`. */
const isText = (matches: (text: string) => boolean) => (kid: Node) => kid.type === 'Text' && matches(textOf(kid))

const mountNarrowPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'wait-review',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'wait-review',
    props: { ...PANE_PROPS, bodyColumns: 56, placement: 'inline' },
    viewport: { columns: 60, rows: 30 },
  })

const BAR = /^─{12}$/

test('in a 60-column pane the header keeps its tag whole and gives up the bar before the counts', async ($, on) => {
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-narrow-head')
  const ui = await mountNarrowPane($)

  // Four to read: the counts are short, and the bar still fits beside them.
  const fresh = await ui.drawn()
  expect(parentOf(fresh, isText(kid => kid === ' wait-review '))?.props?.flexShrink).toBe(0)
  expect(parentOf(fresh, isText(kid => BAR.test(kid)))?.props?.flexShrink).toBe(0)

  await ui.press({ key: 'ok' }) // a.ts
  await ui.press({ key: 'flag' }) // b.ts
  await ui.press({ key: 'drop' }) // c.ts
  // "1 to read · 1 read · 1 flagged · 1 skipped" beside the tag and a bar would
  // take 71 columns of the 56 there are: the bar goes, the counts stay.
  const busy = await ui.drawn()
  expect(textOf(busy)).toContain('1 to read · 1 read · 1 flagged · 1 skipped')
  expect(parentOf(busy, isText(kid => BAR.test(kid)))).toBeUndefined()
  expect(parentOf(busy, isText(kid => kid === ' wait-review '))?.props?.flexShrink).toBe(0)
  await ui.unmount()
})

test('in a 60-column pane the path is cut from its start, and its counts never wrap', async ($, on) => {
  await queueOne($, on, FOUR_HUNKS_DIFF, 'turn-narrow-path')
  const ui = await mountNarrowPane($)

  const drawn = await ui.drawn()
  const counts = parentOf(drawn, isText(kid => /file 1 of 4/.test(kid)))
  expect(counts?.props?.flexShrink).toBe(0)
  const path = (await ui.findAll({ type: 'Text' })).find(one => one.props.wrap === 'truncate-start')
  expect(path).toBeDefined()
  await ui.unmount()
})
