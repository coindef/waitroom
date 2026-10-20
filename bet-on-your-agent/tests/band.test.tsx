import type { On } from 'claude-code'
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
  // Called 2-3 and landed on exactly 3 distinct files: a right call.
  expect(await pane.find({ text: /files called 1\/1/ })).toBeDefined()
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

test('the record pane draws on every surface', async $ => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'bet-on-your-agent', surface, ...PANE })

    expect(await ui.find({ text: /No turns yet/ })).toBeDefined()
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
