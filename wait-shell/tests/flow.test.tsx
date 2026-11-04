import type { On } from 'claude-code'
import type { ElementQuery, Engine, FoundElement } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The whole loop through the engine: Bash calls raised as tool calls the
 * test's own hook answers, the count on the status line while a turn runs,
 * the list above the prompt while it runs and after it ends, and the two
 * actions: put this turn's list away, or turn it off for good. Nothing is
 * ever blocked, rewritten, rerun, written or fetched.
 */

const TITLE = 'Shell commands this turn'
const SUBTITLE = 'Newest last · only a list, nothing blocked or sent'

type Shell = {
  /** Commands a hook beneath the plugin refuses. */
  denied?: readonly string[]
  /** Commands that exit non-zero. */
  failing?: readonly string[]
  /** Commands the person interrupts. */
  stopped?: readonly string[]
  /** Commands left running in the background. */
  background?: readonly string[]
  /** Commands whose answer waits until the test opens their gate. */
  held?: Readonly<Record<string, Promise<void>>>
}

type Settings = { refuse?: string; set: { key: string; value: unknown }[] }

const engineBottom = (
  on: On,
  shell: Shell = {},
  settings: Settings = { set: [] },
  store: Record<string, unknown> = {},
  /** When it answers true, every write to the turn's record throws, as a full disk would. */
  storeFails?: () => boolean,
) => {
  /** Every status line the plugin set, `undefined` for a clear. */
  const said: (string | undefined)[] = []
  /** Every Bash call that reached the bottom, as it arrived. */
  const reached: { command: string; agentId?: string }[] = []
  const ran: string[][] = []
  const wrote: string[] = []
  const fetched: string[] = []
  const completes = { count: 0 }
  mock.store(on, store)
  if (storeFails !== undefined) {
    on('state.set', ($, e, next) => {
      if (storeFails()) throw new Error('disk full')

      return next(e)
    })
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => {
    completes.count += 1

    return { text: e.answer }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    reached.push({ command: e.command, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) })
    const hold = shell.held?.[e.command]
    if (hold !== undefined) await hold
    if (shell.denied?.includes(e.command)) return { deny: 'not here' }
    if (shell.failing?.includes(e.command)) return { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
    if (shell.stopped?.includes(e.command)) return { result: { stdout: '', stderr: '', interrupted: true } }
    if (shell.background?.includes(e.command)) {
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' } }
    }

    return { result: { stdout: `${e.command}: ok\n`, stderr: '', interrupted: false } }
  })
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    throw new Error(`wait-shell runs no process: ${e.argv.join(' ')}`)
  })
  on('fs.write', ($, e) => {
    wrote.push(e.path)
    throw new Error(`wait-shell writes no file: ${e.path}`)
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-shell opens no connection: ${e.url}`)
  })
  on('config.list', () => ({
    value: [
      {
        key: 'wait-shell.enabled',
        label: 'List the shell commands a turn ran',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'wait-shell', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    if (settings.refuse !== undefined) return { deny: settings.refuse }
    settings.set.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return { said, reached, ran, wrote, fetched, completes }
}

/** Only the status lines that showed something. */
const shown = (said: readonly (string | undefined)[]) => said.filter(text => text !== undefined)

/** A gate a held command's answer waits on, opened by the test. */
const gate = () => {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })

  return { opened, open: () => open() }
}

/** A Bash call the way the model makes one, from the main loop or (with `agentId`) a subagent. */
const bash = ($: Engine, command: string, extra: { agentId?: string; run_in_background?: boolean } = {}) =>
  $.tool.call({ tool: 'Bash', command, ...extra })

const finish = (turnId: string, isAborted = false) =>
  ({ turnId, answer: 'done', durationMs: 1000, isAborted, reason: isAborted ? 'aborted' : 'answer' }) as const

const BAND = { component: 'AbovePrompt', requestId: 'above-prompt', viewport: { columns: 140, rows: 40 } } as const

const bandProps = (isWorking: boolean, hasSurvey: boolean, maxRows: number) =>
  ({ hasSurvey, isWorking, maxRows, bodyColumns: 135, scroll: { offset: 0, bodyRows: maxRows }, view: {} }) as const

const mountBand = ($: Engine, isWorking: boolean, { hasSurvey = false, maxRows = 6 } = {}) =>
  $.ui.mount({ plugin: 'wait-shell', surface: 'terminal', ...BAND, props: bandProps(isWorking, hasSurvey, maxRows) })

/** The command rows a band shows, top to bottom, on whichever surface it was drawn. */
const rowsOf = async (band: { findAll: (query: ElementQuery) => Promise<FoundElement[]> }) =>
  (await band.findAll({ type: 'Text', text: /^\$ / })).map(row => row.text)

test('three commands: a live count and list, newest last, up after the turn; nothing blocked, written or fetched', async ($, on) => {
  const { said, reached, ran, wrote, fetched } = engineBottom(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'look around', turnId: 'turn-1' })

  const empty = await mountBand($, true)
  expect(await empty.find({ text: TITLE })).toBeUndefined()
  await empty.unmount()
  expect(shown(said)).toEqual([])

  const first = await bash($, 'ls')
  // Never refused and never rewritten: the tool's own answer comes back as it was.
  expect(first.deny).toBeUndefined()
  expect(first.result).toEqual({ stdout: 'ls: ok\n', stderr: '', interrupted: false })
  expect(said.at(-1)).toBe('1 shell command')
  await bash($, 'git status')
  expect(said.at(-1)).toBe('2 shell commands')
  await bash($, 'echo hi')
  expect(said.at(-1)).toBe('3 shell commands')
  // Each command reached the shell once, exactly as it was written.
  expect(reached).toEqual([{ command: 'ls' }, { command: 'git status' }, { command: 'echo hi' }])

  // While the turn runs, the list is up on either surface.
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'wait-shell', surface, ...BAND, props: bandProps(true, false, 6) })
    expect(await band.find({ text: TITLE })).toBeDefined()
    expect(await band.find({ text: SUBTITLE })).toBeDefined()
    expect(await rowsOf(band)).toEqual(['$ ls', '$ git status', '$ echo hi'])
    const buttons = await band.findAll({ type: 'Button' })
    expect(buttons.map(one => one.key).sort()).toEqual(['disable', 'dismiss'])
    // Only a list: no button on it reruns, stops, undoes or sends anything.
    for (const button of buttons) expect(button.text).not.toMatch(/run|stop|kill|undo|revert|block|copy|send/i)
    await band.unmount()
  }

  const answer = await $.turn.complete(finish('turn-1'))
  expect(answer.text).toBe('done')
  expect(said.at(-1)).toBe('3 shell commands')

  // After the turn: still up, until Close or the next turn.
  const after = await mountBand($, false)
  expect(await after.find({ text: TITLE })).toBeDefined()
  expect(await rowsOf(after)).toEqual(['$ ls', '$ git status', '$ echo hi'])
  await after.unmount()

  expect(reached).toHaveLength(3)
  expect(ran).toEqual([])
  expect(wrote).toEqual([])
  expect(fetched).toEqual([])
})

test('a failed, stopped or background command has a word beside it; one a hook refused never ran and is not listed', async ($, on) => {
  const { said } = engineBottom(on, {
    denied: ['rm -rf build'],
    failing: ['npm test'],
    stopped: ['sleep 60'],
    background: ['npm run dev'],
  })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })

  const refused = await bash($, 'rm -rf build')
  expect(refused.deny).toBe('not here')
  expect(shown(said)).toEqual([])
  const failed = await bash($, 'npm test')
  expect(failed.isError).toBe(true)
  expect(failed.text).toBe('Exit code 1')
  await bash($, 'sleep 60')
  await bash($, 'npm run dev', { run_in_background: true })
  expect(said.at(-1)).toBe('3 shell commands')

  const band = await mountBand($, true)
  expect(await rowsOf(band)).toEqual(['$ npm test', '$ sleep 60', '$ npm run dev'])
  expect(await band.find({ type: 'Text', text: 'error' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'stopped' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'background' })).toBeDefined()
  expect(await band.find({ text: /rm -rf/ })).toBeUndefined()
  await band.unmount()
})

test('a multi-line or long command is one row, cut short, and reaches the shell untouched', async ($, on) => {
  const { reached } = engineBottom(on)
  const script = 'cd web\n  npm   i\n'
  const long = `echo ${'x'.repeat(300)}`
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await bash($, script)
  await bash($, long)
  expect(reached.map(call => call.command)).toEqual([script, long])

  const band = await mountBand($, true)
  const rows = await rowsOf(band)
  expect(rows[0]).toBe('$ cd web ↵ npm i')
  expect(rows[1]?.startsWith('$ echo xxx')).toBe(true)
  expect(rows[1]?.endsWith('…')).toBe(true)
  expect(Array.from(rows[1] ?? '')).toHaveLength(2 + 200)
  await band.unmount()
})

test('ten commands show the newest eight, and one line above them counts the two before', async ($, on) => {
  const { said } = engineBottom(on)
  await $.turn.start({ text: 'many', turnId: 'turn-many' })
  for (let at = 1; at <= 10; at++) await bash($, `echo ${at}`)
  expect(said.at(-1)).toBe('10 shell commands')

  const band = await mountBand($, true, { maxRows: 40 })
  expect(await band.find({ type: 'Text', text: '2 earlier commands…' })).toBeDefined()
  expect(await rowsOf(band)).toEqual(['$ echo 3', '$ echo 4', '$ echo 5', '$ echo 6', '$ echo 7', '$ echo 8', '$ echo 9', '$ echo 10'])
  await band.unmount()
})

test('a short band keeps the newest commands in view instead of scrolling them out', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'some', turnId: 'turn-short' })
  for (const command of ['ls', 'pwd', 'git status', 'git diff', 'npm i']) await bash($, command)

  // Six rows: title, subtitle, the earlier count, and the newest three.
  const band = await mountBand($, true, { maxRows: 6 })
  expect(await band.find({ type: 'Text', text: '2 earlier commands…' })).toBeDefined()
  expect(await rowsOf(band)).toEqual(['$ git status', '$ git diff', '$ npm i'])
  await band.unmount()
})

test('Close puts the list and the count away for the rest of the turn; the next turn starts clean', async ($, on) => {
  const { said } = engineBottom(on)
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await bash($, 'ls')
  await bash($, 'pwd')

  const band = await mountBand($, true)
  await band.press({ key: 'dismiss' })
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
  expect(said.at(-1)).toBeUndefined()

  // Later commands in the same turn are not a reason to bring it back.
  await bash($, 'git status')
  expect(said.at(-1)).toBeUndefined()
  const still = await mountBand($, true)
  expect(await still.find({ text: TITLE })).toBeUndefined()
  await still.unmount()
  await $.turn.complete(finish('turn-1'))
  const after = await mountBand($, false)
  expect(await after.find({ text: TITLE })).toBeUndefined()
  await after.unmount()

  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  expect(said.at(-1)).toBeUndefined()
  await bash($, 'echo hi')
  expect(said.at(-1)).toBe('1 shell command')
  const next = await mountBand($, true)
  expect(await rowsOf(next)).toEqual(['$ echo hi'])
  await next.unmount()
})

test("Don't show again turns it off: later commands set no count and draw nothing", async ($, on) => {
  const settings: Settings = { set: [] }
  const { said } = engineBottom(on, {}, settings)
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await bash($, 'ls')

  const band = await mountBand($, true)
  await band.press({ key: 'disable' })
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
  expect(settings.set).toEqual([{ key: 'wait-shell.enabled', value: false }])
  expect(said.at(-1)).toBeUndefined()

  const lines = said.length
  await bash($, 'pwd')
  await $.turn.complete(finish('turn-1'))
  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  await bash($, 'git status')
  await $.turn.complete(finish('turn-2'))
  expect(shown(said.slice(lines))).toEqual([])
  const later = await mountBand($, false)
  expect(await later.find({ text: TITLE })).toBeUndefined()
  expect(await later.findAll({ type: 'Button' })).toHaveLength(0)
  await later.unmount()
})

test('a refused settings write still keeps it off, and /wait-shell turns it back on', async ($, on) => {
  const settings: Settings = { refuse: 'a managed setting owns it', set: [] }
  const { said } = engineBottom(on, {}, settings)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await bash($, 'ls')

  const band = await mountBand($, true)
  await band.press({ key: 'disable' })
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
  expect(settings.set).toEqual([])

  await $.turn.start({ text: 'still off', turnId: 'turn-2' })
  await bash($, 'pwd')
  expect(said.at(-1)).toBeUndefined()
  const hidden = await mountBand($, true)
  expect(await hidden.find({ text: TITLE })).toBeUndefined()
  await hidden.unmount()
  await $.turn.complete(finish('turn-2'))

  settings.refuse = undefined
  const reply = await $.command.run({ command: 'wait-shell' } as never)
  expect(reply.text).toBe('on · a list of the shell commands each turn runs · /wait-shell turns it off')
  expect(settings.set).toEqual([{ key: 'wait-shell.enabled', value: true }])

  await $.turn.start({ text: 'on again', turnId: 'turn-3' })
  await bash($, 'git status')
  expect(said.at(-1)).toBe('1 shell command')
  const back = await mountBand($, true)
  expect(await rowsOf(back)).toEqual(['$ git status'])
  await back.unmount()
})

test('/wait-shell turns a running install off, and says how to turn it back on', async ($, on) => {
  const settings: Settings = { set: [] }
  const { said } = engineBottom(on, {}, settings)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await bash($, 'ls')
  expect(said.at(-1)).toBe('1 shell command')

  const reply = await $.command.run({ command: 'wait-shell' } as never)
  expect(reply.text).toBe('off · /wait-shell turns it back on · /plugin → wait-shell → List the shell commands a turn ran')
  expect(settings.set).toEqual([{ key: 'wait-shell.enabled', value: false }])
  // The list and the count go at once, mid-turn included.
  expect(said.at(-1)).toBeUndefined()
  const band = await mountBand($, true)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})

test('enabled off never counts and never draws', { options: { enabled: false } }, async ($, on) => {
  const { said, reached } = engineBottom(on)
  await $.turn.start({ text: 'quiet', turnId: 'turn-off' })
  const answer = await bash($, 'ls')
  await $.turn.complete(finish('turn-off'))

  // Off is silent, not in the way: the command still ran.
  expect(answer.result).toEqual({ stdout: 'ls: ok\n', stderr: '', interrupted: false })
  expect(reached).toHaveLength(1)
  expect(shown(said)).toEqual([])
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})

test('a stored disable keeps a default-on install silent', async ($, on) => {
  const { said } = engineBottom(on, {}, { set: [] }, { disabled: true })
  await $.turn.start({ text: 'quiet', turnId: 'turn-stored' })
  await bash($, 'ls')
  await $.turn.complete(finish('turn-stored'))

  expect(shown(said)).toEqual([])
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})

test("a subagent's commands count toward the main turn; once the turn ends, only a subagent's still join it", async ($, on) => {
  const { said } = engineBottom(on)
  await $.turn.start({ text: 'main', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub', agentId: 'agent-1' })
  await bash($, 'ls', { agentId: 'agent-1' })
  expect(said.at(-1)).toBe('1 shell command')
  await $.turn.complete({ ...finish('sub'), agentId: 'agent-1' })
  // A subagent's start and end leave the main turn's list as it was.
  const mid = await mountBand($, true)
  expect(await rowsOf(mid)).toEqual(['$ ls'])
  await mid.unmount()
  await bash($, 'pwd')
  expect(said.at(-1)).toBe('2 shell commands')
  await $.turn.complete(finish('main'))

  // After the turn, a call from no agent is not this turn's; a background agent's still is.
  await bash($, 'whoami')
  expect(said.at(-1)).toBe('2 shell commands')
  await bash($, 'npm test', { agentId: 'agent-2' })
  expect(said.at(-1)).toBe('3 shell commands')
  const band = await mountBand($, false)
  expect(await rowsOf(band)).toEqual(['$ ls', '$ pwd', '$ npm test'])
  await band.unmount()
})

test('a stopped turn keeps its list', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 'turn-abort' })
  await bash($, 'npm i')
  await $.turn.complete(finish('turn-abort', true))

  const band = await mountBand($, false)
  expect(await rowsOf(band)).toEqual(['$ npm i'])
  await band.unmount()
})

test('a command that started in the turn and came back after it ended still counts toward it', async ($, on) => {
  const sleep = gate()
  const { said } = engineBottom(on, { stopped: ['sleep 60'], held: { 'sleep 60': sleep.opened } })
  await $.turn.start({ text: 'wait', turnId: 'turn-1' })
  const pending = bash($, 'sleep 60')
  // Esc ends the turn while the command is still running; its answer comes after.
  await $.turn.complete(finish('turn-1', true))
  sleep.open()
  const answer = await pending
  expect(answer.result).toEqual({ stdout: '', stderr: '', interrupted: true })
  expect(said.at(-1)).toBe('1 shell command')

  const band = await mountBand($, false)
  expect(await rowsOf(band)).toEqual(['$ sleep 60'])
  expect(await band.find({ type: 'Text', text: 'stopped' })).toBeDefined()
  await band.unmount()
})

test('a call that started before a turn began is never that turn’s, wherever its answer lands', async ($, on) => {
  const late = gate()
  const early = gate()
  const { said } = engineBottom(on, { held: { 'npm test': late.opened, whoami: early.opened } })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await bash($, 'ls')
  await $.turn.complete(finish('turn-1'))

  // Both start once turn one has ended: a subagent's, and one from no agent.
  const agents = bash($, 'npm test', { agentId: 'agent-1' })
  const nobodys = bash($, 'whoami')
  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  await bash($, 'git status')
  // Both answers land while turn two runs.
  late.open()
  early.open()
  await agents
  await nobodys
  expect(said.at(-1)).toBe('1 shell command')

  const band = await mountBand($, true)
  expect(await rowsOf(band)).toEqual(['$ git status'])
  await band.unmount()
})

test('a turn that runs no command sets no count and draws nothing', async ($, on) => {
  const { said } = engineBottom(on)
  await $.turn.start({ text: 'think', turnId: 'turn-quiet' })
  const waiting = await mountBand($, true)
  expect(await waiting.find({ text: TITLE })).toBeUndefined()
  expect(await waiting.findAll({ type: 'Button' })).toHaveLength(0)
  await waiting.unmount()
  await $.turn.complete(finish('turn-quiet'))

  const after = await mountBand($, false)
  expect(await after.find({ text: TITLE })).toBeUndefined()
  expect(await after.findAll({ type: 'Button' })).toHaveLength(0)
  await after.unmount()
  expect(shown(said)).toEqual([])
})

test('a survey already up keeps the row, same as the other mods', async ($, on) => {
  engineBottom(on)
  await $.turn.start({ text: 'go', turnId: 'turn-survey' })
  await bash($, 'ls')

  const survey = await mountBand($, true, { hasSurvey: true })
  expect(await survey.find({ text: TITLE })).toBeUndefined()
  await survey.unmount()
})

test(
  'a breathe nudge beneath keeps the row while the turn runs, and the count stays on the status line',
  {
    plugins: [
      {
        name: 'wait-breathe',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
            if (!e.props.isWorking) return next(e)
            const { Text } = $.ui.resolve(e)

            return <Text>breathe: posture check</Text>
          })
        },
      },
    ],
  },
  async ($, on) => {
    const { said } = engineBottom(on)
    await $.turn.start({ text: 'go', turnId: 'turn-share' })
    await bash($, 'ls')
    expect(said.at(-1)).toBe('1 shell command')

    const waiting = await mountBand($, true)
    expect(await waiting.find({ text: /posture check/ })).toBeDefined()
    expect(await waiting.find({ text: TITLE })).toBeUndefined()
    await waiting.unmount()

    // Once the turn ends the nudge is gone, and the list has the row.
    await $.turn.complete(finish('turn-share'))
    const after = await mountBand($, false)
    expect(await after.find({ text: TITLE })).toBeDefined()
    expect(await after.find({ text: /posture check/ })).toBeUndefined()
    await after.unmount()
  },
)

test(
  'between turns a wait-secret card beneath keeps the row, and the list shows once that one is closed',
  {
    plugins: [
      {
        name: 'wait-secret',
        tier: 'append',
        register(on) {
          // The stand-in's own state: an inline plugin runs in an environment of its own.
          let isUp = true
          on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
            if (!isUp || e.props.isWorking) return next(e)
            const { Box, Text, Button } = $.ui.resolve(e)
            const close = () => {
              isUp = false
              $.ui.invalidate('ui.render')
            }

            return (
              <Box>
                <Text>Possible secrets in what this turn wrote</Text>
                <Button key="close" plain onPress={close}>
                  Close
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
    await $.turn.start({ text: 'go', turnId: 'turn-share' })
    await bash($, 'ls')

    // While the turn runs that card is not up, so the list has the row.
    const waiting = await mountBand($, true)
    expect(await waiting.find({ text: TITLE })).toBeDefined()
    await waiting.unmount()

    await $.turn.complete(finish('turn-share'))
    const band = await mountBand($, false)
    expect(await band.find({ text: 'Possible secrets in what this turn wrote' })).toBeDefined()
    expect(await band.find({ text: TITLE })).toBeUndefined()
    await $.ui.press({ plugin: 'wait-secret', key: 'close' })
    await band.unmount()

    const after = await mountBand($, false)
    expect(await after.find({ text: TITLE })).toBeDefined()
    expect(await after.find({ text: 'Possible secrets in what this turn wrote' })).toBeUndefined()
    await after.unmount()
  },
)

test('a store write that throws after a command never runs it twice, and its answer comes back untouched', async ($, on) => {
  let armed = false
  const { reached, completes } = engineBottom(on, {}, { set: [] }, {}, () => armed)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  armed = true
  const answer = await bash($, 'npm i')
  expect(answer.result).toEqual({ stdout: 'npm i: ok\n', stderr: '', interrupted: false })
  expect(reached).toHaveLength(1)
  const done = await $.turn.complete(finish('turn-1'))
  expect(done.text).toBe('done')
  expect(completes.count).toBe(1)
})
