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
