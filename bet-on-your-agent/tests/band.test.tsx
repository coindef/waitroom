import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
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
  // A denied call never reaches a tool, so a file it names was never
  // written; '/denied.ts' stands in for one here.
  on('tool.call', { tool: 'Edit' }, ($, e) =>
    e.file_path === '/denied.ts' ? { deny: 'denied for test' } : ({ result: {} as never }),
  )
  on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'NotebookEdit' }, () => ({ result: {} as never }))
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
  // Five forecasts and a way out of being asked.
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)

  await ui.press({ key: 'p80' })

  // The confidence row is answered, so the band moves on rather than stacking.
  expect(await ui.find({ text: /how many files/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(5)

  await ui.press({ key: 'f2-3' })

  // The bonus is a third, rotating question — still one answer at a time.
  expect(await ui.find({ text: /Bonus: how long will this turn take\?/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)

  await ui.press({ key: 'b<30s' })

  // The daily challenge is a fourth, optional question — still one at a time.
  expect(await ui.find({ text: /Daily challenge:/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
  // Fixed text with no quote to give way: wrapped in a narrow band, never cut
  // at its edge, where "…use more tool ca…" lost what it was asking.
  const [question] = await ui.findAll({ type: 'Text', text: /Daily challenge: will this turn/ })
  expect(question?.props.wrap).toBe('wrap')

  await ui.press({ key: 'decline' })

  expect(await ui.find({ text: /bet 80% · 2–3 files/ })).toBeDefined()
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

  // Answered, so the band has nothing left to ask - only what it recorded.
  expect(await idle.find({ text: /you said/ })).toBeUndefined()
  expect(await idle.find({ text: /Recorded: Needed fixing/ })).toBeDefined()

  // One press puts it back to owed, for a misread verdict.
  await idle.press({ key: 'undo' })
  expect(await idle.find({ text: /you said 95%/ })).toBeDefined()

  // Answered again, so the record below sees exactly one scored turn.
  await idle.press({ key: 'fixed' })
  await idle.unmount()

  // And the call shows up in the record, scored and named.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /overconfident/ })).toBeDefined()
  expect(await pane.find({ text: /refactor the auth layer/ })).toBeDefined()
  // Its own stat, on its own line, not packed into one dim run-on sentence.
  expect(await pane.find({ text: /Lands first try 0% \(0\/1\)/ })).toBeDefined()
  await pane.unmount()
})

test('files are counted from Edit, Write and NotebookEdit calls, the same path once', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'add a feature', turnId: 'turn-6' })

  // The same file edited twice counts once; a denied call counts not at all.
  await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'y', new_string: 'z' })
  await $.tool.call({ tool: 'Edit', file_path: '/denied.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Write', file_path: '/b.ts', content: 'hi' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/c.ipynb', new_source: 'print(1)' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  expect(await betting.find({ text: /3 written so far/ })).toBeUndefined()
  await betting.press({ key: 'p80' })
  await betting.press({ key: 'f2-3' })
  // The bonus question and the daily challenge are not under test here.
  await betting.press({ key: 'decline' })
  await betting.press({ key: 'decline' })
  expect(await betting.find({ text: /bet 80% · 2–3 files · 3 written so far/ })).toBeDefined()
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-6',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // The files stat surfaces even for someone who always skips the
  // landed/fixed verdict: it comes from the Edit/Write/NotebookEdit calls,
  // not from scoring.
  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  await idle.press({ key: 'skip' })
  await idle.unmount()

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  // Called 2–3 and landed on exactly 3 distinct files: a right call.
  expect(await pane.find({ text: /File count called right 1\/1\./ })).toBeDefined()
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

test('a bet left unanswered for hours is not what the next session opens on', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  on('command.register', ($$, e) => ({ value: { command: e.name } }))
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($$, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Box } = $$.ui.resolve(e)

    return <Box />
  })
  const said: (string | undefined)[] = []
  on('ui.status', ($$, e) => {
    said.push(e.text)

    return { value: undefined }
  })

  await $.turn.start({ text: 'migrate the billing tables', turnId: 'turn-late' })
  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p90' })
  await betting.unmount()
  await $.turn.complete({
    turnId: 'turn-late',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
  expect(said.at(-1)).toBe('did it land? 1 to answer')

  // The person walked away; the next session starts the next morning.
  await clock.advance(16 * 60 * 60 * 1000)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  expect(await idle.find({ text: /migrate the billing tables/ })).toBeUndefined()
  expect(await idle.findAll({ type: 'Button' })).toHaveLength(0)
  await idle.unmount()
  expect(said.at(-1)).not.toContain('did it land')

  // It lapsed rather than vanished: the turn is still on the record, unscored.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /waiting on your verdict/ })).toBeUndefined()
  await pane.unmount()
})

test('the turn that just landed is the one asked about, not an older one', async ($, on) => {
  engineBottom(on)
  const betOn = async (turnId: string, text: string) => {
    await $.turn.start({ text, turnId })
    const betting = await $.ui.mount({
      plugin: 'bet-on-your-agent',
      surface: 'terminal',
      ...BAND,
      props: bandProps(true),
    })
    await betting.press({ key: 'p80' })
    await betting.unmount()
    await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  }

  // The first is left unanswered; the second is the one just watched.
  await betOn('turn-first', 'explain what the retry helper does')
  await betOn('turn-second', 'list the exported functions')

  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  expect(await idle.find({ text: /list the exported functions/ })).toBeDefined()
  expect(await idle.find({ text: /explain what the retry helper/ })).toBeUndefined()

  // Answered, the older one comes up behind it.
  await idle.press({ key: 'landed' })
  expect(await idle.find({ text: /explain what the retry helper/ })).toBeDefined()
  await idle.unmount()
})

test('files written through the shell count, not only Edit and Write calls', async ($, on) => {
  engineBottom(on)
  // What git reports: nothing changed when the turn starts, two files after
  // one shell command writes them with a heredoc - which makes no Edit call.
  const repo = { status: '', hashes: '' }
  const ran = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return ran('/work\n')
    if (argv.includes('status')) return ran(repo.status)
    if (argv.includes('hash-object')) return ran(repo.hashes)

    return ran('')
  })
  on('tool.call', { tool: 'Bash' }, () => {
    repo.status = [' M src/retry.ts', ' M src/client.ts', ''].join('\0')
    repo.hashes = 'aaa\nbbb\n'

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'add backoff to retry', turnId: 'turn-sh' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await band.press({ key: 'p80' })
  await band.press({ key: 'f2-3' })
  // The bonus question and the daily challenge are not under test here.
  await band.press({ key: 'decline' })
  await band.press({ key: 'decline' })
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: "cat > src/retry.ts <<'EOF' ... EOF" } as never)
  expect(await band.find({ text: /2 written so far/ })).toBeDefined()
  await band.unmount()

  await $.turn.complete({
    turnId: 'turn-sh',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // Answered, so the report has a scored turn to show its stats beside.
  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  await idle.press({ key: 'landed' })
  await idle.unmount()

  // The file forecast is scored on the two files the shell wrote.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /File count called right 1\/1/ })).toBeDefined()
  await pane.unmount()
})

const gitRan = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** A nested repository or a worktree: `git hash-object` exits 128 on the path. */
const isUnhashable = (path: string) => path === 'sub/' || path.startsWith('.wt/')

/**
 * A git the shell-write tests can move underneath a running turn.
 *
 * Hashing a batch that contains an unhashable path fails the whole call, the
 * way `git hash-object` does. Hashing one path reports that path alone.
 */
const trackGit = (on: On, repo: { status: string; hashes: string }) => {
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return gitRan('/work\n')
    if (argv.includes('status')) return gitRan(repo.status)
    if (argv.includes('hash-object')) {
      const dash = e.argv.lastIndexOf('--')
      const paths = dash === -1 ? [] : e.argv.slice(dash + 1)
      if (paths.some(path => isUnhashable(path))) return gitRan('', 128)

      return gitRan(repo.hashes)
    }

    return gitRan('')
  })
}

const betNone = async (band: { press: (key: { key: string }) => Promise<unknown> }) => {
  await band.press({ key: 'p80' })
  await band.press({ key: 'f0' })
  // The bonus question and the daily challenge are not under test here.
  await band.press({ key: 'decline' })
  await band.press({ key: 'decline' })
}

test('one unhashable path at turn start does not hide the files the shell writes', async ($, on) => {
  engineBottom(on)
  const repo = { status: ['?? sub/', ''].join('\0'), hashes: '' }
  trackGit(on, repo)
  on('tool.call', { tool: 'Bash' }, () => {
    repo.status = ['?? sub/', ' M src/a.ts', ' M src/b.ts', ''].join('\0')
    repo.hashes = 'aaa\nbbb\n'

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'write two files through the shell', turnId: 'turn-unhash' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  await $.tool.call({ tool: 'Bash', command: 'sed -i ... src/a.ts src/b.ts' } as never)
  expect(await band.find({ text: /2 written so far/ })).toBeDefined()
  expect(await band.find({ text: /0 written so far/ })).toBeUndefined()
  await band.unmount()

  await $.turn.complete({
    turnId: 'turn-unhash',
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
  await idle.press({ key: 'landed' })
  await idle.unmount()

  // Called none and the shell wrote two: a miss, not a free point for zero.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /File count called right 0\/1/ })).toBeDefined()
  await pane.unmount()
})

test('an unhashable path that appears mid-turn does not hide that turn’s shell writes', async ($, on) => {
  engineBottom(on)
  const repo = { status: '', hashes: '' }
  trackGit(on, repo)
  on('tool.call', { tool: 'Bash' }, () => {
    repo.status = ['?? .wt/x/', ' M src/a.ts', ' M src/b.ts', ''].join('\0')
    repo.hashes = 'aaa\nbbb\n'

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'write two files through the shell', turnId: 'turn-unhash-2' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'git worktree add .wt/x && sed -i ...' } as never)
  expect(await band.find({ text: /2 written so far/ })).toBeDefined()
  expect(await band.find({ text: /0 written so far/ })).toBeUndefined()
  await band.unmount()
})

test('a turn that leaves more than 500 changed paths is not scored as writing none', async ($, on) => {
  engineBottom(on)
  const repo = { status: '', hashes: '' }
  trackGit(on, repo)
  on('tool.call', { tool: 'Bash' }, () => {
    const paths = Array.from({ length: 501 }, (_, at) => `gen/f${at}.ts`)
    repo.status = [...paths.map(path => `?? ${path}`), ''].join('\0')
    repo.hashes = paths.map((_, at) => `h${at}`).join('\n') + '\n'

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'generate the fixtures', turnId: 'turn-many' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'node gen.js' } as never)
  expect(await band.find({ text: /file count unknown \(500\+ paths\)/ })).toBeDefined()
  expect(await band.find({ text: /0 written so far/ })).toBeUndefined()
  await band.unmount()

  await $.turn.complete({
    turnId: 'turn-many',
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
  await idle.press({ key: 'landed' })
  await idle.unmount()

  // The call was "none". Scoring it would be a point for a count we never read.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /Calibrating/ })).toBeDefined()
  expect(await pane.find({ text: /File count called right/ })).toBeUndefined()
  await pane.unmount()
})

test('a tree already past 500 paths still scores the Edit and Write calls', async ($, on) => {
  engineBottom(on)
  const paths = Array.from({ length: 600 }, (_, at) => `dist/f${at}.js`)
  const repo = { status: [...paths.map(path => `?? ${path}`), ''].join('\0'), hashes: '' }
  trackGit(on, repo)

  await $.turn.start({ text: 'edit two sources', turnId: 'turn-huge-start' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await band.press({ key: 'p80' })
  await band.press({ key: 'f2-3' })
  // The bonus question and the daily challenge are not under test here.
  await band.press({ key: 'decline' })
  await band.press({ key: 'decline' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/b.ts', old_string: 'x', new_string: 'y' })
  expect(await band.find({ text: /2 written so far/ })).toBeDefined()
  expect(await band.find({ text: /file count unknown/ })).toBeUndefined()
  await band.unmount()

  await $.turn.complete({
    turnId: 'turn-huge-start',
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
  await idle.press({ key: 'landed' })
  await idle.unmount()

  // Called 2–3 and the two edits are the whole count: a right call, not a dropped one.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /File count called right 1\/1/ })).toBeDefined()
  await pane.unmount()
})

test('exactly 500 changed paths are still a count', async ($, on) => {
  engineBottom(on)
  const paths = Array.from({ length: 500 }, (_, at) => `gen/f${at}.ts`)
  const repo = { status: '', hashes: '' }
  trackGit(on, repo)
  on('tool.call', { tool: 'Bash' }, () => {
    repo.status = [...paths.map(path => `?? ${path}`), ''].join('\0')
    repo.hashes = paths.map((_, at) => `h${at}`).join('\n') + '\n'

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'generate exactly 500', turnId: 'turn-500' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  await $.tool.call({ tool: 'Bash', command: 'node gen.js' } as never)
  expect(await band.find({ text: /500 written so far/ })).toBeDefined()
  expect(await band.find({ text: /file count unknown/ })).toBeUndefined()
  await band.unmount()
})

test('crossing 500 paths during the turn makes the file count unknown', async ($, on) => {
  engineBottom(on)
  const prior = Array.from({ length: 499 }, (_, at) => `gen/f${at}.ts`)
  const repo = {
    status: [...prior.map(path => `?? ${path}`), ''].join('\0'),
    hashes: prior.map((_, at) => `h${at}`).join('\n') + '\n',
  }
  trackGit(on, repo)
  on('tool.call', { tool: 'Bash' }, () => {
    const paths = [...prior, 'gen/extra-a.ts', 'gen/extra-b.ts']
    repo.status = [...paths.map(path => `?? ${path}`), ''].join('\0')
    repo.hashes = paths.map((_, at) => `h${at}`).join('\n') + '\n'

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'the tree grows past the cap', turnId: 'turn-cross' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'node gen.js' } as never)
  expect(await band.find({ text: /file count unknown \(500\+ paths\)/ })).toBeDefined()
  expect(await band.find({ text: /written so far/ })).toBeUndefined()
  await band.unmount()

  await $.turn.complete({
    turnId: 'turn-cross',
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
  await idle.press({ key: 'landed' })
  await idle.unmount()

  // Called none. The count was never read, so it is not a point for zero.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /File count called right/ })).toBeUndefined()
  await pane.unmount()
})

test('one unhashable path does not ask git about every other path', async ($, on) => {
  engineBottom(on)
  const paths = Array.from({ length: 32 }, (_, at) => `src/f${at}.ts`)
  const repo = { status: '', hashes: '' }
  let hashCalls = 0
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return gitRan('/work\n')
    if (argv.includes('status')) return gitRan(repo.status)
    if (argv.includes('hash-object')) {
      hashCalls += 1
      const dash = e.argv.lastIndexOf('--')
      const asked = dash === -1 ? [] : e.argv.slice(dash + 1)
      if (asked.some(path => isUnhashable(path))) return gitRan('', 128)
      const lines = asked.map(path => {
        const at = paths.indexOf(path)

        return at === -1 ? 'x' : `h${at}`
      })

      return gitRan(lines.join('\n') + '\n')
    }

    return gitRan('')
  })
  on('tool.call', { tool: 'Bash' }, () => {
    repo.status = [...paths.map(path => `?? ${path}`), '?? sub/', ''].join('\0')
    hashCalls = 0

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'write many files around a nested repo', turnId: 'turn-fast' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  await $.tool.call({ tool: 'Bash', command: 'node gen.js' } as never)
  // One bad path used to turn into one git call per file. A split isolates it.
  expect(hashCalls).toBeLessThanOrEqual(16)
  expect(await band.find({ text: /32 written so far/ })).toBeDefined()
  expect(await band.find({ text: /file count unknown/ })).toBeUndefined()
  await band.unmount()
})

test('a path whose hash times out is not counted as written', async ($, on) => {
  engineBottom(on)
  const repo = {
    status: [' M src/keep.ts', ' M src/slow.ts', ''].join('\0'),
    later: false,
  }
  on('process.run', ($$, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return gitRan('/work\n')
    if (argv.includes('status')) {
      const lines = repo.later
        ? [' M src/keep.ts', ' M src/slow.ts', '?? sub/', '']
        : [' M src/keep.ts', ' M src/slow.ts', '']

      return gitRan(lines.join('\0'))
    }
    if (argv.includes('hash-object')) {
      const dash = e.argv.lastIndexOf('--')
      const asked = dash === -1 ? [] : e.argv.slice(dash + 1)
      if (asked.some(path => isUnhashable(path))) return gitRan('', 128)
      // Any call that still has to read the slow path does not answer, the way a
      // `hash-object` of that path hits its timeout.
      if (repo.later && asked.includes('src/slow.ts')) throw new Error('timed out')
      const lines = asked.map(path => (path === 'src/keep.ts' ? 'aaa' : 'bbb'))

      return gitRan(lines.join('\n') + '\n')
    }

    return gitRan('')
  })
  on('tool.call', { tool: 'Bash' }, () => {
    repo.later = true

    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

  await $.turn.start({ text: 'touch nothing, one hash stalls', turnId: 'turn-timeout' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betNone(band)
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'true' } as never)
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()
  expect(await band.find({ text: /1 written so far/ })).toBeUndefined()
  expect(await band.find({ text: /file count unknown/ })).toBeUndefined()
  await band.unmount()
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

test('the record pane draws on every surface', async ($, on) => {
  // A working store with no history yet. A thrown read is a different case:
  // that one says the turns are not being saved.
  mock.store(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'bet-on-your-agent', surface, ...PANE })

    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
    // The badge wall is always shown, even with nothing recorded: all six
    // badges, all locked.
    expect(await ui.find({ text: /Badges/ })).toBeDefined()
    expect(await ui.find({ text: /First Steps/ })).toBeDefined()
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })

    await ui.unmount()
  }
})

test('a bet can be waved away, and the band then leaves the row alone', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'something I have no view on', turnId: 'turn-5' })

  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })

  expect(await ui.find({ text: /land first try/ })).toBeDefined()
  await ui.press({ key: 'decline' })

  // A prompt you cannot dismiss is a nag: the band asks nothing more this turn.
  expect(await ui.find({ text: /land first try/ })).toBeUndefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)

  await ui.unmount()
})

test('the status line says what to do next, not the plugin name again', async ($, on) => {
  engineBottom(on)
  const said: (string | undefined)[] = []
  on('ui.status', ($$, e) => {
    said.push(e.text)

    return { value: undefined }
  })

  await $.turn.start({ text: 'add the retry logic', turnId: 'turn-s1' })
  // While the turn runs and nothing is called, it teaches the one keystroke.
  expect(said.at(-1)).toBe('type 1–5 to call this turn')

  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await ui.press({ key: 'p80' })
  await ui.unmount()
  expect(said.at(-1)).toBe('you said 80%')

  await $.turn.complete({
    turnId: 'turn-s1',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
  expect(said.at(-1)).toBe('did it land? 1 to answer')

  // The engine prefixes the plugin's own name, so none of these repeat it.
  expect(said.every(text => text === undefined || !text.startsWith('bet'))).toBe(true)
})

test('a declined turn leaves the status line alone', async ($, on) => {
  engineBottom(on)
  const said: (string | undefined)[] = []
  on('ui.status', ($$, e) => {
    said.push(e.text)

    return { value: undefined }
  })

  await $.turn.start({ text: 'no view on this one', turnId: 'turn-s2' })
  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await ui.press({ key: 'decline' })
  await ui.unmount()

  expect(said.at(-1)).toBeUndefined()
})

test('a failed read of the history leaves the stored turns in place', async ($, on) => {
  mock.clock(on)
  const old = Array.from({ length: 40 }, (_, at) => ({
    turnId: `old-${at}`,
    at,
    durationMs: 1000,
    files: 0,
    filesBucket: '0' as const,
    toolCalls: 0,
    isAborted: false,
    saidConfidence: 0.8,
    landed: true,
  }))
  const data: Record<string, unknown> = { extrasFrom: '1900-01-01', turns: old }
  let failReads = false
  const said: (string | undefined)[] = []
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/tmp/bet-store-flaky' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('store.get', ($$, e) => {
    if (failReads) throw new Error('EIO: store unreadable for a moment')

    return { value: data[e.key] }
  })
  on('store.set', ($$, e) => {
    data[e.key] = e.value

    return { value: undefined }
  })
  on('ui.status', ($$, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($$, e) => ({ text: e.answer }))

  await $.turn.start({ text: 'a turn', turnId: 'unlucky' })
  // One unreadable moment, covering the read that would otherwise build
  // [thisTurn] and write it over the forty records.
  failReads = true
  await $.turn.complete({
    turnId: 'unlucky',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
  failReads = false

  const kept = data.turns as typeof old
  expect(kept).toHaveLength(40)
  expect(kept.map(one => one.turnId)).toEqual(old.map(one => one.turnId))
  // The turn ended unrecorded, so the line is not left on the running prompt
  // and does not ask whether a turn the store never took landed.
  expect(said.at(-1)).toBeUndefined()
})

/** One stored turn, owed or already scored, for the read-failure tests. */
const storedTurn = (turnId: string, at: number, extra: { ask?: string; landed?: boolean } = {}) => ({
  turnId,
  at,
  durationMs: 1000,
  files: 0,
  filesBucket: '0' as const,
  toolCalls: 0,
  isAborted: false,
  saidConfidence: 0.8,
  ...(extra.ask === undefined ? {} : { ask: extra.ask }),
  ...(extra.landed === undefined ? {} : { landed: extra.landed }),
})

/**
 * A store whose reads can be made to throw, or to hand back something else,
 * so a test can show what a write does when the history cannot be trusted.
 */
const flakyStore = (on: On, entries: Record<string, unknown>) => {
  mock.clock(on)
  const data: Record<string, unknown> = { extrasFrom: '1900-01-01', ...entries }
  let failReads: (key: string) => boolean = () => false
  let failWrites: (key: string) => boolean = () => false
  const logged: string[] = []
  const said: (string | undefined)[] = []
  // No store file here. A repair must not go looking at the real
  // ~/.claude/plugins/store files.
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/tmp/bet-store-flaky' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('store.get', ($, e) => {
    if (failReads(e.key)) throw new Error('EIO: store unreadable for a moment')

    return { value: data[e.key] }
  })
  on('store.set', ($, e) => {
    if (failWrites(e.key)) throw new Error('EROFS: store will not take the write')
    data[e.key] = e.value

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  return {
    data,
    logged,
    said,
    fail(match: (key: string) => boolean = () => true) {
      failReads = match
    },
    failWrites(match: (key: string) => boolean = () => true) {
      failWrites = match
    },
  }
}

const HISTORY_UNREAD = "couldn't read the saved history"
const REBUILT_NOTICE = "couldn't read the saved history · rebuilt"

// Before the other non-array tests: the note is once per process, so a
// later test would already have spent it.
test('a history that is not a list is noted once', async ($, on) => {
  const store = flakyStore(on, { turns: { not: 'a list' } })
  await $.turn.start({ text: 'a turn', turnId: 'corrupt-note' })
  await $.turn.complete({
    turnId: 'corrupt-note',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  await pane.unmount()

  expect(store.data.turns).toEqual({ not: 'a list' })
  expect(store.logged.filter(line => line === "couldn't read the saved history")).toHaveLength(1)
})

test('a history that is not a list is not replaced when the turn is recorded', async ($, on) => {
  const store = flakyStore(on, { turns: { not: 'a list' } })
  await $.turn.start({ text: 'a turn', turnId: 'corrupt-record' })
  await $.turn.complete({
    turnId: 'corrupt-record',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  expect(store.data.turns).toEqual({ not: 'a list' })
})

test('a history that is not a list is not replaced when a verdict is skipped', async ($, on) => {
  const owed = storedTurn('corrupt-skip', 0, { ask: 'tidy the imports' })
  const store = flakyStore(on, { turns: [owed] })
  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  expect(await idle.find({ text: /tidy the imports/ })).toBeDefined()
  store.data.turns = { not: 'a list' }
  await idle.press({ key: 'skip' })
  await idle.unmount()

  expect(store.data.turns).toEqual({ not: 'a list' })
})

test('a history that is not a list is not replaced when a verdict is undone', async ($, on) => {
  const owed = storedTurn('corrupt-undo', 0, { ask: 'undo me' })
  const store = flakyStore(on, { turns: [owed] })
  const idle = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  await idle.press({ key: 'landed' })
  store.data.turns = { not: 'a list' }
  await idle.press({ key: 'undo' })
  await idle.unmount()

  expect(store.data.turns).toEqual({ not: 'a list' })
})

test('a turn that could not be saved says so', async ($, on) => {
  const old = [storedTurn('old-0', 0, { landed: true })]
  const store = flakyStore(on, { turns: old })
  await $.turn.start({ text: 'a turn', turnId: 'unlucky-log' })
  store.fail()
  await $.turn.complete({
    turnId: 'unlucky-log',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  expect(store.data.turns).toEqual(old)
  expect(store.logged).toContain("couldn't save that turn")
  // The status line stays blank; the log line is what explains it.
  expect(store.said.at(-1)).toBeUndefined()
})

test('a store that will not take the write says so', async ($, on) => {
  const old = [storedTurn('old-0', 0, { landed: true })]
  const store = flakyStore(on, { turns: old })
  await $.turn.start({ text: 'a turn', turnId: 'unwritable' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await band.press({ key: 'p80' })
  expect(store.said.at(-1)).toBe('you said 80%')
  store.failWrites()
  await $.turn.complete({
    turnId: 'unwritable',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
  await band.unmount()

  expect(store.data.turns).toEqual(old)
  expect(store.logged).toContain("couldn't save that turn")
  expect(store.said.at(-1)).not.toBe('you said 80%')
})

// A pretend config dir. Nothing under the real ~/.claude/plugins/store is opened.
const ISOLATED_CONFIG = '/tmp/bet-store-isolated'
const STORE_PATH = `${ISOLATED_CONFIG}/plugins/store/bet-on-your-agent.json`

/**
 * The store file as the engine keeps it: empty and unreadable JSON throw,
 * and a write lands back in the same bytes. The bytes live in `files`, not
 * on disk.
 */
const diskStore = (on: On, bytes: string) => {
  mock.clock(on)
  const files = new Map<string, string>([[STORE_PATH, bytes]])
  const logged: string[] = []
  const read = (): Record<string, unknown> => {
    const text = files.get(STORE_PATH)
    if (text === undefined || text.length === 0) throw new Error('empty store')
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('corrupt store')

    return parsed as Record<string, unknown>
  }
  on('env.get', ($, e) => ({
    value: e.name === 'CLAUDE_CONFIG_DIR' ? ISOLATED_CONFIG : e.name === 'HOME' ? '/tmp/bet-store-home' : undefined,
  }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('store.get', ($, e) => ({ value: read()[e.key] }))
  on('store.set', ($, e) => {
    const data = read()
    data[e.key] = e.value
    files.set(STORE_PATH, `${JSON.stringify(data)}\n`)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  return { files, logged }
}

const finishTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: 'a turn', turnId })
  await $.turn.complete({
    turnId,
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })
}

test('a store of zero bytes is initialized and the turn is saved', async ($, on) => {
  const store = diskStore(on, '')
  await finishTurn($, 'empty-file')

  const saved = JSON.parse(store.files.get(STORE_PATH) ?? '') as { turns?: { turnId: string }[] }
  expect(saved.turns?.map(one => one.turnId)).toEqual(['empty-file'])
  expect(store.files.has(`${STORE_PATH}.bak`)).toBe(false)
})

test('a corrupt store is backed up, rebuilt, and /bet says so', async ($, on) => {
  const original = 'not json{'
  const store = diskStore(on, original)
  const reply = await $.command.run({ command: 'bet' } as never)
  const text = reply.text ?? ''

  expect(text).toBe(REBUILT_NOTICE)
  expect(text).toBe(text.toLowerCase())
  expect(text.includes('\n')).toBe(false)
  expect(text.length).toBeLessThanOrEqual(48)
  expect(store.files.get(`${STORE_PATH}.bak`)).toBe(original)
  expect(store.logged).toContain(REBUILT_NOTICE)
  const rebuilt = JSON.parse(store.files.get(STORE_PATH) ?? '') as { turns?: unknown }
  expect(rebuilt.turns).toBeUndefined()

  await finishTurn($, 'after-rebuild')
  const saved = JSON.parse(store.files.get(STORE_PATH) ?? '') as { turns?: { turnId: string }[] }
  expect(saved.turns?.map(one => one.turnId)).toEqual(['after-rebuild'])
})

test('a store whose turns are not a list is backed up and rebuilt', async ($, on) => {
  const listed = JSON.stringify({ turns: { not: 'a list' }, extrasFrom: '1900-01-01' })
  const store = diskStore(on, listed)
  const reply = await $.command.run({ command: 'bet' } as never)

  expect(reply.text).toBe(REBUILT_NOTICE)
  expect((reply.text ?? '').length).toBeLessThanOrEqual(48)
  expect(store.files.get(`${STORE_PATH}.bak`)).toBe(listed)
  const rebuilt = JSON.parse(store.files.get(STORE_PATH) ?? '') as { turns?: unknown; extrasFrom?: string }
  expect(rebuilt.turns).toBeUndefined()
  expect(rebuilt.extrasFrom).toBe('1900-01-01')
})

test('an unreadable history with nothing loaded says turns are not being saved', async ($, on) => {
  const store = flakyStore(on, {})
  store.fail()

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: HISTORY_UNREAD })).toBeDefined()
  expect(await pane.find({ text: /No turns yet/ })).toBeUndefined()
  expect(await pane.find({ text: /Five calls in/ })).toBeUndefined()
  await pane.unmount()

  const reply = await $.command.run({ command: 'bet' } as never)
  expect(reply.text).toBe(HISTORY_UNREAD)
  // A thrown read, with no file to repair, is not a fresh start.
  expect(store.data.turns).toBeUndefined()
})

test('a history that is not a list says turns are not being saved', async ($, on) => {
  const store = flakyStore(on, { turns: { not: 'a list' } })

  const reply = await $.command.run({ command: 'bet' } as never)
  expect(reply.text).toBe(HISTORY_UNREAD)

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: HISTORY_UNREAD })).toBeDefined()
  expect(await pane.find({ text: /No turns yet/ })).toBeUndefined()
  await pane.unmount()

  expect(store.data.turns).toEqual({ not: 'a list' })
})

test('a failed read keeps the last history on the pane, the recap and the band', async ($, on) => {
  const history = [
    ...Array.from({ length: 8 }, (_, at) => storedTurn(`old-${at}`, at, { landed: true, ask: 'an old turn' })),
    storedTurn('owed-1', 8, { ask: 'keep the record' }),
  ]
  const store = flakyStore(on, { turns: history })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  store.fail()

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /No turns yet/ })).toBeUndefined()
  expect(await pane.find({ text: /Brier 0\.040/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(false),
  })
  expect(await band.find({ text: /Did it land/ })).toBeDefined()
  expect(await band.find({ text: /keep the record/ })).toBeDefined()
  await band.unmount()

  const reply = await $.command.run({ command: 'bet-recap' } as never)
  expect(reply.text).toMatch(/Rank\s+Oracle/)
  expect(reply.text).toMatch(/Session Brier\s+0\.040/)
  expect(reply.text).not.toMatch(/Rank\s+Unranked/)
})

test('a failed read of the daily challenges leaves the streak in place', async ($, on) => {
  const streak = [
    { date: '2026-11-13', dim: 'duration' as const, guess: 'yes' as const, actual: 'yes' as const, correct: true },
    { date: '2026-11-14', dim: 'files' as const, guess: 'no' as const, actual: 'no' as const, correct: true },
  ]
  const store = flakyStore(on, { dailyChallenges: streak, turns: [] })
  await $.turn.start({ text: 'add a cache', turnId: 'daily-unlucky' })
  store.fail(key => key === 'dailyChallenges')
  await $.turn.complete({
    turnId: 'daily-unlucky',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  expect(store.data.dailyChallenges).toEqual(streak)
})

/**
 * Someone past their first week: the day the extras surface on their own is
 * already behind the mock clock (which starts at 0), so every question and
 * the badge wall surface as they always have.
 */
const PAST_FIRST_WEEK = { extrasFrom: '1900-01-01' }

/**
 * Session-start-aware engine bottom: `/bet` and `/bet-recap` both need the
 * commands registered, which only happens through `session.start`.
 *
 * `entries` is what the store holds before the session: someone past their
 * first week unless a test says otherwise, `{}` for someone brand new.
 */
const fullEngine = (on: On, entries: Record<string, unknown> = PAST_FIRST_WEEK) => {
  const clock = mock.clock(on)
  mock.store(on, entries)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

  return clock
}

test('the bonus question scores against what actually happened, and shows up in the pane', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'tidy the retry helper', turnId: 'turn-bonus-1' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p80' })
  await betting.press({ key: 'f1' })
  // The first turn of a session rotates to the "duration" dimension.
  expect(await betting.find({ text: /Bonus: how long will this turn take\?/ })).toBeDefined()
  await betting.press({ key: 'b<30s' })
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-bonus-1',
    answer: 'done',
    durationMs: 20000,
    isAborted: false,
    reason: 'answer',
  })

  // Scored the moment the turn lands, no land/fail verdict required.
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /Bonus: 1\/1 correct/ })).toBeDefined()
  await pane.unmount()
})

test('skipping the bonus question costs nothing and is never scored', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a guard clause', turnId: 'turn-bonus-2' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p80' })
  await betting.press({ key: 'f1' })
  await betting.press({ key: 'decline' })
  await betting.press({ key: 'decline' })
  // Skipped: the band has nothing left to ask this turn.
  expect(await betting.findAll({ type: 'Button' })).toHaveLength(0)
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-bonus-2',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  // The Bonus Hunter badge still shows in the wall below (locked or not); the
  // stat line is what a skipped bonus question must not add.
  expect(await pane.find({ text: /Bonus:/ })).toBeUndefined()
  await pane.unmount()
})

test('a rank climb prints a celebratory line once, in the band and the text report', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const betOn = async (turnId: string, confidenceKey: string, landed: boolean) => {
    await $.turn.start({ text: 'a turn', turnId })
    const betting = await $.ui.mount({
      plugin: 'bet-on-your-agent',
      surface: 'terminal',
      ...BAND,
      props: bandProps(true),
    })
    await betting.press({ key: confidenceKey })
    await betting.unmount()
    await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

    const idle = await $.ui.mount({
      plugin: 'bet-on-your-agent',
      surface: 'terminal',
      ...BAND,
      props: bandProps(false),
    })
    await idle.press({ key: landed ? 'landed' : 'fixed' })
    const sawRankUp = (await idle.find({ text: /Rank up/ })) !== undefined
    await idle.unmount()

    return sawRankUp
  }

  // Five misses at 90%: rolling Brier 0.81, rank Coin-Flipper.
  for (let at = 0; at < 5; at++) await betOn(`bad-${at}`, 'p90', false)

  const coinFlipper = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await coinFlipper.find({ text: /Coin-Flipper/ })).toBeDefined()
  await coinFlipper.unmount()

  // Landed calls at 90% pull the rolling mean down; the climb fires exactly
  // once, on whichever one first crosses a rank's threshold.
  let climbed = false
  for (let at = 0; at < 9 && !climbed; at++) climbed = await betOn(`good-${at}`, 'p90', true)

  expect(climbed).toBe(true)

  const reply = await $.command.run({ command: 'bet' } as never)
  expect(reply.text).toContain('Rank up:')

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /Bronze/ })).toBeDefined()
  await pane.unmount()
})

test('/bet-recap prints a shareable, plain-text card for this session', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add the retry logic', turnId: 'turn-recap-1' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p90' })
  await betting.press({ key: 'f1' })
  await betting.press({ key: 'decline' })
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-recap-1',
    answer: 'done',
    durationMs: 20000,
    isAborted: false,
    reason: 'answer',
  })

  const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
  await idle.press({ key: 'landed' })
  await idle.unmount()

  const reply = await $.command.run({ command: 'bet-recap' } as never)

  expect(reply.text).toContain('Session recap')
  expect(reply.text).toContain('Turns bet')
  // The badge wall and the daily challenge ride along on the same card.
  expect(reply.text).toContain('Badges')
  expect(reply.text).toContain('Daily challenge')
  // Copy-paste friendly: no ANSI escapes inside the box.
  expect(reply.text).not.toMatch(/\u001b/)
})

test("a subagent's tool calls stay off the open turn's tool-call count", async ($, on) => {
  fullEngine(on)
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'Read' }, () => ({ result: {} as never }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // Duration, then files, so the turn under test asks about tool calls.
  for (const turnId of ['rot-1', 'rot-2']) {
    await $.turn.start({ text: 'rotate', turnId })
    await $.turn.complete({
      turnId,
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      reason: 'answer',
    })
  }

  await $.turn.start({ text: 'main turn', turnId: 'm1' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await band.press({ key: 'p80' })
  await band.press({ key: 'f0' })
  expect(await band.find({ text: /how many tool calls will it make\?/ })).toBeDefined()
  // 3–6 is what this turn's own calls land on. Five subagent calls would push it to 7+.
  await band.press({ key: 'b3-6' })
  expect(await band.find({ text: /0 written so far/ })).toBeDefined()

  // The file still counts: the question is how many files the turn touches.
  // The five calls do not count toward the tool-call bonus.
  await $.tool.call({
    tool: 'Edit',
    file_path: '/work/sub.ts',
    old_string: 'x',
    new_string: 'y',
    agentId: 'agent-1',
  } as never)
  for (let at = 0; at < 4; at++) {
    await $.tool.call({ tool: 'Read', file_path: '/work/sub-read.ts', agentId: 'agent-1' } as never)
  }
  expect(await band.find({ text: /1 written so far/ })).toBeDefined()

  // The main turn's own calls still count: a second file, and three tool calls in all.
  await $.tool.call({ tool: 'Edit', file_path: '/work/main.ts', old_string: 'x', new_string: 'y' })
  expect(await band.find({ text: /2 written so far/ })).toBeDefined()
  for (let at = 0; at < 2; at++) {
    await $.tool.call({ tool: 'Read', file_path: `/work/main-${at}.ts` } as never)
  }
  await band.unmount()
  await $.turn.complete({
    turnId: 'm1',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /Bonus: 1\/1 correct/ })).toBeDefined()
  await pane.unmount()
})

test('/bet-recap this session leaves out a turn another window recorded', async ($, on) => {
  const other = {
    turnId: 'other-session-turn',
    at: 5,
    durationMs: 1000,
    files: 0,
    filesBucket: '0',
    toolCalls: 0,
    isAborted: false,
    saidConfidence: 0.95,
    landed: false,
    ask: 'something from another window',
    sessionId: 'other-window',
  }
  fullEngine(on, { ...PAST_FIRST_WEEK, turns: [other] })
  on('session.id', () => ({ value: 'this-window' }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // This window's own call stays on the card. The other window's does not.
  await $.turn.start({ text: 'the turn this window made', turnId: 'mine' })
  const band = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await band.press({ key: 'p80' })
  await band.press({ key: 'f0' })
  await band.press({ key: 'decline' })
  await band.press({ key: 'decline' })
  await band.unmount()
  await $.turn.complete({
    turnId: 'mine',
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
  await idle.press({ key: 'landed' })
  await idle.unmount()

  const reply = await $.command.run({ command: 'bet-recap' } as never)

  expect(reply.text).toMatch(/Turns bet\s+1/)
  expect(reply.text).not.toContain('something from ano')
  // 80% and it landed: (0.8 - 1) squared is 0.040. The other window's 0.902 is not in the mean.
  expect(reply.text).toMatch(/Session Brier\s+0\.040/)
})

test('/bet-recap draws its card to fit the terminal it is printed in', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'In src/config_loader_for_the_extremely_long_module_name.ts append a function', turnId: 'turn-fit-1' })
  const betting = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
  await betting.press({ key: 'p80' })
  await betting.press({ key: 'f1' })
  await betting.press({ key: 'decline' })
  await betting.unmount()
  await $.turn.complete({ turnId: 'turn-fit-1', answer: 'done', durationMs: 20000, isAborted: false, reason: 'answer' })
  const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
  await idle.press({ key: 'landed' })
  await idle.unmount()

  const widest = async (columns: number) => {
    const reply = await $.command.run({
      command: 'bet-recap',
      args: '',
      presentation: { isFullscreen: true, columns },
    } as never)

    return Math.max(...(reply.text ?? '').split('\n').map(line => [...line].length))
  }
  // The reply sits behind a five-column gutter: in 60 columns the card gets 55.
  expect(await widest(60)).toBeLessThanOrEqual(55)
  expect(await widest(120)).toBe(60)
})

test('/bet and its pane both show the badge wall beside the record, not just /bet-recap', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a guard clause', turnId: 'turn-badge-wall' })

  const betting = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
  await betting.press({ key: 'p80' })
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-badge-wall',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
  await idle.press({ key: 'landed' })
  await idle.unmount()

  const reply = await $.command.run({ command: 'bet' } as never)
  expect(reply.text).toContain('Badges')
  expect(reply.text).toContain('✓ First Steps')
  expect(reply.text).toContain('— Oracle Path')

  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /Badges/ })).toBeDefined()
  expect(await pane.find({ text: /First Steps/ })).toBeDefined()
  await pane.unmount()
})

test('a newly earned badge prints one quiet line beside the scoring output', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a helper', turnId: 'turn-badge-1' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p80' })
  await betting.press({ key: 'f1' })
  await betting.press({ key: 'decline' }) // the bonus question is not under test here
  await betting.press({ key: 'decline' }) // nor is the daily challenge
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-badge-1',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
  await idle.press({ key: 'landed' })

  // The first-ever scored verdict earns First Steps, named beside "Recorded".
  expect(await idle.find({ text: /Recorded: Landed/ })).toBeDefined()
  expect(await idle.find({ text: /Badge earned: First Steps/ })).toBeDefined()
  await idle.unmount()
})

test('no badge note shows when nothing was newly earned', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add another helper', turnId: 'turn-badge-2' })

  const betting = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await betting.press({ key: 'p80' })
  await betting.press({ key: 'f1' })
  await betting.press({ key: 'decline' })
  await betting.press({ key: 'decline' })
  await betting.unmount()

  await $.turn.complete({
    turnId: 'turn-badge-2',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // Skipping the verdict earns nothing, so there is nothing to announce.
  const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
  await idle.press({ key: 'skip' })
  expect(await idle.find({ text: /Badge earned/ })).toBeUndefined()
  await idle.unmount()
})

test('the daily challenge is offered once a day, scored automatically, and not re-offered on a later turn the same day', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a cache', turnId: 'turn-daily-1' })

  const first = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await first.press({ key: 'p80' })
  await first.press({ key: 'f1' })
  await first.press({ key: 'decline' }) // the bonus question is not under test here
  expect(await first.find({ text: /Daily challenge:/ })).toBeDefined()
  await first.press({ key: 'yes' })
  await first.unmount()

  await $.turn.complete({
    turnId: 'turn-daily-1',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // A second turn the same (mocked) day finds today already handled.
  await $.turn.start({ text: 'add a second cache', turnId: 'turn-daily-2' })
  const second = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await second.press({ key: 'p80' })
  await second.press({ key: 'f1' })
  await second.press({ key: 'decline' })
  expect(await second.find({ text: /Daily challenge:/ })).toBeUndefined()
  // With nothing further to ask, the band drops straight to its quiet background.
  expect(await second.findAll({ type: 'Button' })).toHaveLength(0)
  await second.unmount()

  await $.turn.complete({
    turnId: 'turn-daily-2',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // Today's result shows in the recap card, right or missed either way.
  const reply = await $.command.run({ command: 'bet-recap' } as never)
  expect(reply.text).toMatch(/Daily challenge\s+(right today|missed today)/)
})

test('a daily challenge offered but never answered or declined is not re-offered on a later turn the same day', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a feature', turnId: 'turn-untouched-1' })

  // The main bet is placed and the bonus declined, but the turn lands with
  // the daily challenge still on screen — never answered, never declined.
  const first = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await first.press({ key: 'p80' })
  await first.press({ key: 'f1' })
  await first.press({ key: 'decline' })
  expect(await first.find({ text: /Daily challenge:/ })).toBeDefined()
  await first.unmount()

  await $.turn.complete({
    turnId: 'turn-untouched-1',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // A later turn the same day must not repeat the identical question.
  await $.turn.start({ text: 'add another feature', turnId: 'turn-untouched-2' })
  const second = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await second.press({ key: 'p80' })
  await second.press({ key: 'f1' })
  await second.press({ key: 'decline' })
  expect(await second.find({ text: /Daily challenge:/ })).toBeUndefined()
  await second.unmount()

  await $.turn.complete({
    turnId: 'turn-untouched-2',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  // Distinct from a day with no turns at all, which reads a plain em dash.
  const reply = await $.command.run({ command: 'bet-recap' } as never)
  expect(reply.text).toMatch(/Daily challenge\s+not taken/)
})

test('a turn with no bet placed at all still handles today’s untouched challenge, so it is not re-offered either', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  // Nobody opens the band this turn — it just runs and lands, with the
  // challenge assigned at turn.start but never seen, let alone answered.
  await $.turn.start({ text: 'quick fix', turnId: 'turn-nobet-1' })
  await $.turn.complete({
    turnId: 'turn-nobet-1',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  await $.turn.start({ text: 'quick fix again', turnId: 'turn-nobet-2' })
  const second = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  expect(await second.find({ text: /Daily challenge:/ })).toBeUndefined()
  await second.unmount()

  await $.turn.complete({
    turnId: 'turn-nobet-2',
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  })

  const reply = await $.command.run({ command: 'bet-recap' } as never)
  expect(reply.text).toMatch(/Daily challenge\s+not taken/)
})

test('the daily challenge asks about a typical turn, not a personal median, before there is enough history', async ($, on) => {
  fullEngine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'add a cache', turnId: 'turn-fallback-1' })

  const ui = await $.ui.mount({
    plugin: 'bet-on-your-agent',
    surface: 'terminal',
    ...BAND,
    props: bandProps(true),
  })
  await ui.press({ key: 'p80' })
  await ui.press({ key: 'f1' })
  await ui.press({ key: 'decline' }) // the bonus question is not under test here

  // A fresh session has no scored history yet, so the challenge is judged
  // against the fixed fallback — the question should not claim a median.
  expect(await ui.find({ text: /than a typical turn\?/ })).toBeDefined()
  expect(await ui.find({ text: /than your median\?/ })).toBeUndefined()
  await ui.unmount()
})

const DAY = 24 * 60 * 60 * 1000

/** Opens the band while a turn runs, answers the two core questions, and hands back what is left on screen. */
const callCore = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: 'add a cache', turnId })
  const band = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
  await band.press({ key: 'p80' })
  await band.press({ key: 'f1' })

  return band
}

test('a new person’s first week asks the core questions alone: no bonus, no daily challenge', async ($, on) => {
  fullEngine(on, {})
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const band = await callCore($, 'turn-new-1')
  // Straight from the files question to the quiet line: nothing more to answer.
  expect(await band.find({ text: /Bonus:/ })).toBeUndefined()
  expect(await band.find({ text: /Daily challenge:/ })).toBeUndefined()
  expect(await band.find({ text: /bet 80% · 1 file/ })).toBeDefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()

  // Held back, not gone: /bet-recap is where they are found, and says when they start.
  const reply = await $.command.run({ command: 'bet-recap' } as never)
  expect(reply.text).toMatch(/Bonus\s+starts in 7 days/)
  expect(reply.text).toMatch(/Daily challenge\s+starts in 7 days/)
  expect(reply.text).toContain('Badges')
})

test('the extras surface on their own the day the first week is over, not a day before', async ($, on) => {
  const clock = fullEngine(on, {})
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await clock.advance(6 * DAY)
  const sixth = await callCore($, 'turn-day-7')
  expect(await sixth.find({ text: /Bonus:/ })).toBeUndefined()
  await sixth.unmount()
  await $.turn.complete({ turnId: 'turn-day-7', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  const reply = await $.command.run({ command: 'bet-recap' } as never)
  expect(reply.text).toMatch(/Bonus\s+starts tomorrow/)

  await clock.advance(DAY)
  const eighth = await callCore($, 'turn-day-8')
  expect(await eighth.find({ text: /Bonus: how long will this turn take\?/ })).toBeDefined()
  await eighth.press({ key: 'decline' })
  expect(await eighth.find({ text: /Daily challenge:/ })).toBeDefined()
  await eighth.unmount()
})

test('in the first week a scored call earns its badge quietly: no note in the row, the wall in /bet-recap alone', async ($, on) => {
  fullEngine(on, {})
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const betting = await callCore($, 'turn-new-badge')
  await betting.unmount()
  await $.turn.complete({ turnId: 'turn-new-badge', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

  const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
  await idle.press({ key: 'landed' })
  expect(await idle.find({ text: /Recorded: Landed/ })).toBeDefined()
  expect(await idle.find({ text: /Badge earned/ })).toBeUndefined()
  await idle.unmount()

  // The core loop stays in view: the record and the rank, without the wall.
  const record = await $.command.run({ command: 'bet' } as never)
  expect(record.text).toContain('Rank: Unranked.')
  expect(record.text).not.toContain('Badges')
  const pane = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...PANE })
  expect(await pane.find({ text: /Calibrating/ })).toBeDefined()
  expect(await pane.find({ text: /Badges/ })).toBeUndefined()
  await pane.unmount()

  // The badge it earned is there to be found.
  const recap = await $.command.run({ command: 'bet-recap' } as never)
  expect(recap.text).toMatch(/First Steps\s+✓/)
})

test('someone with a record already keeps every extra from the first session of this version on', async ($, on) => {
  const earlier = {
    turnId: 'from-before',
    at: 0,
    durationMs: 20000,
    files: 1,
    filesBucket: '1',
    toolCalls: 2,
    isAborted: false,
    saidConfidence: 0.8,
    landed: true,
  }
  fullEngine(on, { turns: [earlier] })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const band = await callCore($, 'turn-existing')
  expect(await band.find({ text: /Bonus:/ })).toBeDefined()
  await band.unmount()

  const record = await $.command.run({ command: 'bet' } as never)
  expect(record.text).toContain('✓ First Steps')
  const recap = await $.command.run({ command: 'bet-recap' } as never)
  expect(recap.text).not.toContain('starts in')
})

/*
 * The row above the prompt is shared with wait-breathe and wait-ship, and the
 * bet comes last in it. Each stand-in below loads beneath this mod (`append`)
 * under the real mod's name, which is what the engine stamps on its row, so
 * it is what this mod finds when it asks what is beneath it. An inline plugin
 * closes over nothing of this file, so each is written out whole.
 */

test(
  'a breathe nudge beneath keeps the row while the bet question waits, never both at once',
  {
    plugins: [
      {
        name: 'wait-breathe',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box gap={1}>
                <Text>breathe: stand up and stretch</Text>
                <Button key="taken" hotkey="b" plain onPress={() => undefined}>
                  Took it
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on)
    await $.turn.start({ text: 'add the retry logic', turnId: 'turn-q1' })

    const band = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
    expect(await band.find({ text: /stand up and stretch/ })).toBeDefined()
    expect(await band.find({ text: /land first try/ })).toBeUndefined()
    expect(await band.find({ key: 'p80' })).toBeUndefined()
    await band.unmount()
  },
)

test(
  'a ship offer beneath comes ahead of "Did it land?", which is asked the moment the offer is answered',
  {
    plugins: [
      {
        name: 'wait-ship',
        tier: 'append',
        register(on) {
          let isAnswered = false
          on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
            if (isAnswered) return next(e)
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box flexDirection="column">
                <Text>ship: Drafts ready</Text>
                <Button
                  key="skip"
                  hotkey="s"
                  plain
                  onPress={() => {
                    isAnswered = true
                    $.ui.invalidate('ui.render')
                  }}
                >
                  Skip
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on)
    await $.turn.start({ text: 'refactor the auth layer', turnId: 'turn-q2' })
    const betting = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
    await betting.press({ key: 'p95' })
    await betting.unmount()
    await $.turn.complete({ turnId: 'turn-q2', answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })

    const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
    expect(await idle.find({ text: /Drafts ready/ })).toBeDefined()
    expect(await idle.find({ text: /Did it land\?/ })).toBeUndefined()

    await idle.press({ key: 'skip', plugin: 'wait-ship' })

    // Queued, not lost: the verdict owed is the row's next question.
    expect(await idle.find({ text: /Drafts ready/ })).toBeUndefined()
    expect(await idle.find({ text: /Did it land\?/ })).toBeDefined()
    expect(await idle.find({ text: /you said 95%/ })).toBeDefined()
    await idle.unmount()
  },
)

test(
  'while a turn runs the forecast takes the row from a ship offer beneath, never stacked beside it',
  {
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
                <Button key="skip" hotkey="s" plain onPress={() => undefined}>
                  Skip
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on)
    await $.turn.start({ text: 'refactor the auth layer', turnId: 'turn-q3' })
    const betting = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
    // The betting window closes when the turn lands, so the forecast cannot wait behind the offer.
    expect(await betting.find({ text: /land first try/ })).toBeDefined()
    expect(await betting.find({ key: 'p80' })).toBeDefined()
    expect(await betting.find({ text: /Drafts ready/ })).toBeUndefined()
    expect(await betting.find({ key: 'skip' })).toBeUndefined()
    await betting.unmount()
  },
)

test(
  'with nothing of its own to ask, the bet passes the row beneath through untouched',
  {
    plugins: [
      {
        name: 'wait-ship',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Text } = $.ui.resolve(e)

            return <Text>ship: Drafts ready</Text>
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on)
    const idle = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(false) })
    expect(await idle.find({ text: /Drafts ready/ })).toBeDefined()
    await idle.unmount()
  },
)

test(
  'a row beneath from outside waitroom does not hold the bet back, as before',
  {
    plugins: [
      {
        name: 'some-other-plugin',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Text } = $.ui.resolve(e)

            return <Text>another plugin's row</Text>
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on)
    await $.turn.start({ text: 'add the retry logic', turnId: 'turn-q4' })
    const band = await $.ui.mount({ plugin: 'bet-on-your-agent', surface: 'terminal', ...BAND, props: bandProps(true) })
    expect(await band.find({ text: /land first try/ })).toBeDefined()
    expect(await band.find({ text: /another plugin's row/ })).toBeUndefined()
    await band.unmount()
  },
)
