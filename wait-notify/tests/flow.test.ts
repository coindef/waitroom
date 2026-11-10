import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import {
  FRONTMOST_ARGV,
  FRONTMOST_SCRIPT,
  IOREG_ARGV,
  LIVE_TTL_MS,
  notifyArgv,
  PERMISSION_BODY,
  QUESTION_BODY,
  reminderBody,
  STOP_BODY,
} from '../hooks/notify'

/**
 * The whole loop through the engine: Notification events, tool calls, prompts
 * and turn ends raised as Claude Code raises them, `process.run` answered by
 * a pretend Mac, the config file by the test's `fs.read`, the session's id and
 * root by the test's host, the plugin store by the mock store, and the
 * reminder's timer by the mock clock. Nothing here is spawned or posted for real.
 */

const HOME = '/Users/ada'
const CONFIG = `${HOME}/.waitroom/notify.json`
const MIN = 60_000
const HOUR = 60 * MIN
/** Where the mock clock starts: 2026-11-10 09:00 UTC. */
const NOW = 1_794_301_200_000

const SAFARI = '/Applications/Safari.app/'
const ITERM = '/Applications/iTerm.app/'

/** Host session ids, as Claude Code names a session: a uuid. */
const ID_A = '3f2a6c1e-8d4b-4f0a-9e2d-5b7c1a0e9f31'
const ID_B = '9b1c0d2e-4a5f-4c3b-8e7d-1f2a3b4c5d6e'
const ID_C = 'c4d5e6f7-0a1b-4c2d-8e3f-9a8b7c6d5e4f'

type Mac = {
  /** What `uname` prints. */
  uname: string
  /** What `ioreg` reports as HIDIdleTime, in seconds. */
  idleSeconds: number
  /** What the frontmost-app check prints. */
  front: string
  /** The text of `~/.waitroom/notify.json`; undefined: there is none. */
  config?: string
  /** No HOME in the environment. */
  noHome?: boolean
  /** `display notification` fails, as it does with notifications turned off. */
  notifyFails?: boolean
}

const ranValue = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** The part of `ioreg -c IOHIDSystem` that matters, around one HIDIdleTime line. */
const ioregOutput = (idleSeconds: number) =>
  [
    '+-o Root  <class IORegistryEntry, id 0x100000100, retain 31>',
    '  +-o IOResources  <class IOResources, id 0x100000117, registered, matched, active, busy 0 (0 ms), retain 46>',
    '    +-o IOHIDSystem  <class IOHIDSystem, id 0x1000004c9, registered, matched, active, busy 0 (0 ms), retain 23>',
    '        {',
    '          "IOClass" = "IOHIDSystem"',
    `          "HIDIdleTime" = ${Math.round(idleSeconds * 1e9)}`,
    '          "HIDParameters" = {"HIDClickTime"=500000000}',
    '        }',
    '',
  ].join('\n')

/** What the host says about the session. Each answer can change mid-test, as after a `/clear`. */
type Session = {
  /** What `$.session.id()` answers; undefined: the call fails. */
  id?: string
  /** What `$.session.root()` answers; undefined: the call fails. */
  root?: string
}

/**
 * Nothing sits beneath the plugin in a test, so the test stands in for the
 * engine and the Mac.
 *
 * By default the host gives no session id and no project root, so the title
 * is the plain `Claude needs you` the first tests below were written against.
 * The tests of the session label give both, and the store's starting records.
 */
const engineBottom = (
  on: On,
  start: Partial<Mac> = {},
  given: Session & { store?: Record<string, unknown> } = {},
) => {
  const mac: Mac = { uname: 'Darwin', idleSeconds: 1, front: SAFARI, ...start }
  const session: Session = { id: given.id, root: given.root }
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, mac.noHome ? {} : { HOME })
  /** The plugin store, one object the test reads and writes as the other session would. JSON in and out, as the host keeps it. */
  const store: Record<string, unknown> = given.store ?? {}
  /** Set by a test to make the next keys() or get() throw, as a real store failure would. */
  const storeFail: { keys?: Error; get?: Error } = {}
  on('store.get', ($, e) => {
    if (storeFail.get !== undefined) throw storeFail.get

    return { value: store[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(store[e.key])) }
  })
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => {
    if (storeFail.keys !== undefined) throw storeFail.keys

    return { value: Object.keys(store) }
  })
  const ran: string[][] = []
  const read: string[] = []
  /** Tool calls held open this long on the clock: a dialog answered that much later. */
  const holds: Partial<Record<string, number>> = {}
  on('session.id', () => {
    if (session.id === undefined) throw new Error('no session id')

    return { value: session.id }
  })
  on('session.root', () => {
    if (session.root === undefined) throw new Error('no project root')

    return { value: session.root }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.Notification', () => ({}))
  on('classic.ElicitationResult', () => ({}))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('tool.call', async ($, e) => {
    const holdMs = holds[e.tool]
    if (holdMs !== undefined) await clock.sleep(holdMs)

    return { result: { ok: true } }
  })
  on('fs.read', ($, e) => {
    read.push(e.path)
    if (mac.config === undefined || e.path !== CONFIG) throw new Error(`ENOENT: ${e.path}`)

    return { value: mac.config }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const [bin, flag, script] = e.argv
    if (bin === 'uname' && e.argv.length === 1) return ranValue(`${mac.uname}\n`)
    if (bin === 'ioreg') return ranValue(ioregOutput(mac.idleSeconds))
    if (bin === 'osascript' && flag === '-e' && script === FRONTMOST_SCRIPT) return ranValue(`${mac.front}\n`)
    if (bin === 'osascript' && flag === '-e' && script?.startsWith('display notification ')) {
      if (mac.notifyFails) throw new Error('notifications are off')

      return ranValue('')
    }
    throw new Error(`wait-notify runs no such command: ${e.argv.join(' ')}`)
  })

  return { clock, mac, ran, read, holds, session, store, storeFail }
}

const permission = ($: Engine) =>
  $.classic.Notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission' })

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

const finish = (turnId: string, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({
    turnId,
    answer: 'done',
    durationMs: 120_000,
    isAborted: extra.isAborted === true,
    reason: extra.isAborted ? 'aborted' : 'answer',
    ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {}),
  }) as const

/** `uname`, the presence check of someone away, then the notification. */
const NOTIFIED = [['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(PERMISSION_BODY)]

const posted = (ran: readonly string[][]) => ran.filter(argv => argv[2]?.startsWith('display notification '))

test('away: a permission prompt notifies at once, reminds once after 3 minutes, then stays quiet', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  expect(ran).toEqual(NOTIFIED)
  expect(ran[3]?.[2]).toBe('display notification "Waiting on a permission" with title "Claude needs you"')

  await clock.advance(3 * MIN - 1)
  expect(ran).toHaveLength(4)

  await clock.advance(1)
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(reminderBody(3))])
  expect(ran[6]?.[2]).toBe('display notification "Still waiting · 3 min" with title "Claude needs you"')

  await clock.advance(60 * MIN)
  expect(ran).toHaveLength(7)
})

test('at the terminal: typing in iTerm2 with a permission prompt sends nothing, now or later', async ($, on) => {
  const { clock, ran } = engineBottom(on, { idleSeconds: 2, front: ITERM })
  await permission($)
  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV])

  await clock.advance(60 * MIN)
  expect(ran).toHaveLength(3)
})

test('Terminal, Ghostty, VS Code and Cursor count as the terminal too', async ($, on) => {
  const { ran, mac } = engineBottom(on, { idleSeconds: 2 })
  for (const front of [
    '/System/Applications/Utilities/Terminal.app/',
    '/Applications/Ghostty.app/',
    '/Applications/Visual Studio Code.app/',
    '/Applications/Cursor.app/',
  ]) {
    mac.front = front
    await permission($)
  }

  expect(posted(ran)).toEqual([])
  expect(ran.filter(argv => argv[0] === 'uname')).toHaveLength(1)
})

test('idle 30 seconds or more is away with the terminal in front, and the frontmost app is not asked', async ($, on) => {
  const { ran } = engineBottom(on, { idleSeconds: 30, front: ITERM })
  await permission($)

  expect(ran).toEqual([['uname'], IOREG_ARGV, notifyArgv(PERMISSION_BODY)])
})

test('a prompt you send cancels the reminder', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  await clock.advance(1 * MIN)
  await $.prompt.submit(typed('use the staging database instead'))

  await clock.advance(60 * MIN)
  expect(ran).toEqual(NOTIFIED)
})

test('a task notification is not you: the reminder still comes', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  await $.prompt.submit({ text: 'Background task done', wait: false, origin: { kind: 'task-notification' } })

  await clock.advance(3 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
})

test('the waiting tool call going on (you answered) cancels the reminder', async ($, on) => {
  const { clock, ran, holds } = engineBottom(on)
  holds.Bash = 1 * MIN
  const call = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()
  await permission($)

  await clock.advance(1 * MIN)
  expect((await call).result).toEqual({ ok: true })
  await clock.advance(60 * MIN)
  expect(ran).toEqual(NOTIFIED)
})

/**
 * Claude Code's order for a command that needs your OK: its `tool.call` starts
 * (PreToolUse runs inside it, before any dialog), the dialog opens, the
 * Notification comes, you answer, and the command runs. Nothing is raised at
 * your answer, so the hold below is the dialog and the run together.
 */
test('you allow a long command at the terminal and walk away: no reminder while it runs', async ($, on) => {
  const { clock, ran, mac, holds } = engineBottom(on)
  holds.Bash = 5 * MIN
  const call = $.tool.call({ tool: 'Bash', command: 'npm run test:e2e' })
  await clock.settle()
  await permission($)
  expect(ran).toEqual(NOTIFIED)

  // 20 seconds in, you switch to the terminal, press Enter on the dialog and leave.
  mac.front = ITERM
  mac.idleSeconds = 3 * 60 - 20
  await clock.advance(3 * MIN)
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV])

  await clock.advance(2 * MIN)
  expect((await call).result).toEqual({ ok: true })
  await clock.advance(60 * MIN)
  expect(posted(ran)).toEqual([notifyArgv(PERMISSION_BODY)])
})

test('you never answer while the call waits: the reminder still comes at 3 minutes', async ($, on) => {
  const { clock, ran, mac, holds } = engineBottom(on, { idleSeconds: 45, front: ITERM })
  holds.Bash = 10 * MIN
  const call = $.tool.call({ tool: 'Bash', command: 'npm run test:e2e' })
  await clock.settle()
  await permission($)
  expect(ran).toEqual([['uname'], IOREG_ARGV, notifyArgv(PERMISSION_BODY)])

  // The terminal stays in front, and no key or mouse event comes after the notification.
  mac.idleSeconds = 45 + 3 * 60
  await clock.advance(3 * MIN)
  expect(ran.slice(3)).toEqual([IOREG_ARGV, notifyArgv(reminderBody(3))])

  await clock.advance(7 * MIN)
  expect((await call).result).toEqual({ ok: true })
  expect(posted(ran)).toHaveLength(2)
})

test('a new prompt later in the same turn, once you have walked away, notifies and reminds as usual', async ($, on) => {
  const { clock, ran, mac, holds } = engineBottom(on)
  holds.Bash = 5 * MIN
  const first = $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await clock.settle()
  await permission($)
  mac.front = ITERM
  mac.idleSeconds = 3 * 60 - 20
  await clock.advance(5 * MIN)
  await first
  expect(posted(ran)).toEqual([notifyArgv(PERMISSION_BODY)])

  // Your last key was the first answer, 4 minutes 40 seconds ago.
  mac.idleSeconds = 5 * 60 - 20
  const second = $.tool.call({ tool: 'Bash', command: 'npm run deploy:staging' })
  await clock.settle()
  await permission($)
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))

  mac.idleSeconds += 3 * 60
  await clock.advance(3 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
  expect(posted(ran)).toEqual([notifyArgv(PERMISSION_BODY), notifyArgv(PERMISSION_BODY), notifyArgv(reminderBody(3))])

  await clock.advance(2 * MIN)
  await second
})

test("a tool call that starts after the notification, a background agent's, does not cancel it", async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', agentId: 'agent-1' })

  await clock.advance(3 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
})

test('the main turn ending (answered, or Esc) cancels the reminder; a subagent finishing does not', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  await $.turn.complete(finish('turn-sub', { agentId: 'agent-1' }))
  await clock.advance(3 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))

  const before = ran.length
  await permission($)
  await $.turn.complete(finish('turn-esc', { isAborted: true }))
  await clock.advance(60 * MIN)
  expect(ran.slice(before)).toEqual([IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(PERMISSION_BODY)])
})

test('back at the terminal by the recheck: no reminder, and none after', async ($, on) => {
  const { clock, ran, mac } = engineBottom(on)
  await permission($)
  mac.front = ITERM
  mac.idleSeconds = 4

  await clock.advance(3 * MIN)
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV])

  mac.front = SAFARI
  await clock.advance(60 * MIN)
  expect(ran).toHaveLength(6)
})

test('a permission_prompt while AskUserQuestion is open says "Asked you a question", and answering it cancels the reminder', async ($, on) => {
  const { clock, ran, holds } = engineBottom(on)
  holds.AskUserQuestion = 2 * MIN
  const asked = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which database should the tests use?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'The one production runs' },
          { label: 'SQLite', description: 'One file, nothing to start' },
        ],
        multiSelect: false,
      },
    ],
  })
  await clock.settle()
  await permission($)
  expect(ran.at(-1)).toEqual(notifyArgv(QUESTION_BODY))
  expect(ran.at(-1)?.[2]).toBe('display notification "Asked you a question" with title "Claude needs you"')

  await clock.advance(2 * MIN)
  await asked
  await clock.advance(60 * MIN)
  expect(ran).toHaveLength(4)

  await permission($)
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))
})

test('an MCP server\'s question (elicitation_dialog) says "Asked you a question", and answering it cancels the reminder', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await $.classic.Notification({ notification_type: 'elicitation_dialog', message: 'Claude Code needs your input' })
  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(QUESTION_BODY)])

  await $.classic.ElicitationResult({ mcp_server_name: 'tracker', action: 'accept' })
  await clock.advance(60 * MIN)
  expect(ran).toHaveLength(4)
})

test('idle_prompt and every other notification type send nothing and run nothing', async ($, on) => {
  const { clock, ran, read } = engineBottom(on)
  for (const type of [
    'idle_prompt',
    'auth_success',
    'elicitation_url_dialog',
    'agent_needs_input',
    'agent_completed',
    'worker_permission_prompt',
    'plugin_notification',
  ]) {
    await $.classic.Notification({ notification_type: type, message: 'Claude is waiting for your input' })
  }

  await clock.advance(60 * MIN)
  expect(ran).toEqual([])
  expect(read).toEqual([])
})

test('a normal turn end is silent by default, and runs no command', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  const done = await $.turn.complete(finish('turn-1'))

  expect(done.text).toBe('done')
  await clock.advance(60 * MIN)
  expect(ran).toEqual([])
})

test('notify_on_stop: a turn end notifies when you are away, never after Esc or for a subagent, and not when you are back', async ($, on) => {
  const { clock, ran, mac } = engineBottom(on, { config: '{ "notify_on_stop": true }' })
  await $.turn.complete(finish('turn-away'))
  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(STOP_BODY)])

  await $.turn.complete(finish('turn-esc', { isAborted: true }))
  await $.turn.complete(finish('turn-sub', { agentId: 'agent-1' }))
  await clock.advance(60 * MIN)
  expect(ran).toHaveLength(4)

  mac.front = ITERM
  await $.turn.complete(finish('turn-here'))
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV])
})

test('not macOS: uname is all that runs, with no notification and no error, now or later', async ($, on) => {
  const { clock, ran, read } = engineBottom(on, { uname: 'Linux', config: '{ "notify_on_stop": true }' })
  await permission($)
  await $.classic.Notification({ notification_type: 'elicitation_dialog', message: 'Claude Code needs your input' })
  const done = await $.turn.complete(finish('turn-1'))

  expect(done.text).toBe('done')
  await clock.advance(60 * MIN)
  expect(ran).toEqual([['uname']])
  // Only the turn end read the file, to learn notify_on_stop. A prompt on Linux reads nothing.
  expect(read).toEqual([CONFIG])
})

test('the config file sets the idle threshold and the reminder delay, and the reminder says those minutes', async ($, on) => {
  const { clock, ran, read, mac } = engineBottom(on, {
    config: '{ "present_idle_secs": 60, "remind_after_min": 1 }',
    idleSeconds: 45,
    front: ITERM,
  })
  await permission($)
  expect(read).toEqual([CONFIG])
  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV])

  mac.front = SAFARI
  await permission($)
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))

  await clock.advance(1 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(1)))
  expect(ran.at(-1)?.[2]).toContain('"Still waiting · 1 min"')
})

test('a broken config file falls back to every default: 3 minutes, and a silent turn end', async ($, on) => {
  const { clock, ran } = engineBottom(on, { config: '{ "remind_after_min": 1, "notify_on_stop": true,' })
  await permission($)
  await clock.advance(1 * MIN)
  expect(ran).toHaveLength(4)

  await clock.advance(2 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
  await $.turn.complete(finish('turn-1'))
  expect(ran).toHaveLength(7)
})

test('no HOME: no file is read, and the defaults hold', async ($, on) => {
  const { clock, ran, read } = engineBottom(on, { noHome: true })
  await permission($)
  await clock.advance(3 * MIN)

  expect(read).toEqual([])
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
})

test('a notification that fails to post does not fail the event, and the reminder is still tried', async ($, on) => {
  const { clock, ran } = engineBottom(on, { notifyFails: true })
  await permission($)
  expect(ran).toEqual(NOTIFIED)

  await clock.advance(3 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
})

test('a second prompt while the first waits replaces it: one reminder, 3 minutes after the second', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  await clock.advance(2 * MIN)
  await $.classic.Notification({ notification_type: 'elicitation_dialog', message: 'Claude Code needs your input' })
  expect(ran.at(-1)).toEqual(notifyArgv(QUESTION_BODY))

  await clock.advance(1 * MIN)
  expect(ran).toHaveLength(7)

  await clock.advance(2 * MIN)
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
  expect(posted(ran)).toHaveLength(3)
})

test('/clear cancels a pending reminder', async ($, on) => {
  const { clock, ran } = engineBottom(on)
  await permission($)
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })

  await clock.advance(60 * MIN)
  expect(ran).toEqual(NOTIFIED)
})

const START = { cwd: '/work/api', surface: 'terminal', isInteractive: true } as const

/** The AppleScript of the last notification posted. */
const lastScript = (ran: readonly string[][]) => posted(ran).at(-1)?.[2]

/** A live record with no parent folder: an older build's, or a folder right under the root. */
const live = (name: string, seenAt = NOW) => ({ v: 1, name, seenAt })

/** A live record as this build writes it for a folder with a parent: `liveIn('work', 'api')` for `…/work/api`. */
const liveIn = (parent: string, name: string, seenAt = NOW) => ({ v: 1, name, parent, seenAt })

/**
 * From here on the host answers as another session. One test is one session,
 * so each session's answers stand in for it in turn, on the same store.
 */
const answerAs = (session: Session, id: string, root: string) => {
  session.id = id
  session.root = root
}

test('a single session in /work/api: the notification, its reminder and the stop notification all say `Claude needs you · api`', async ($, on) => {
  const { clock, ran } = engineBottom(on, { config: '{ "notify_on_stop": true }' }, { id: ID_A, root: '/work/api' })
  await $.session.start(START)
  await permission($)
  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(PERMISSION_BODY, 'api')])
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api"')

  await clock.advance(3 * MIN)
  expect(lastScript(ran)).toBe('display notification "Still waiting · 3 min" with title "Claude needs you · api"')

  await $.turn.complete(finish('turn-1'))
  expect(lastScript(ran)).toBe('display notification "Finished · your turn" with title "Claude needs you · api"')
  expect(posted(ran)).toHaveLength(3)
})

test('case 1, two live sessions in /x/work/api and /x/work/web: no folder name is shared, so each title is its folder name alone', async ($, on) => {
  const { ran, session, store } = engineBottom(on, {}, { id: ID_A, root: '/x/work/api' })
  await $.session.start(START)
  answerAs(session, ID_B, '/x/work/web')
  await $.session.start(START)
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · web"')

  answerAs(session, ID_A, '/x/work/api')
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api"')
  expect(store).toEqual({ [`live/${ID_A}`]: liveIn('work', 'api'), [`live/${ID_B}`]: liveIn('work', 'web') })
})

test('case 2, two live sessions in /x/work/api and /x/fork/api: the parent folders differ, so the titles say `work/api` and `fork/api`', async ($, on) => {
  const { clock, ran, session, store } = engineBottom(on, {}, { id: ID_A, root: '/x/work/api' })
  await $.session.start(START)
  answerAs(session, ID_B, '/x/fork/api')
  await $.session.start(START)
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · fork/api"')

  answerAs(session, ID_A, '/x/work/api')
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · work/api"')
  await clock.advance(3 * MIN)
  expect(lastScript(ran)).toBe('display notification "Still waiting · 3 min" with title "Claude needs you · work/api"')
  expect(store).toEqual({ [`live/${ID_A}`]: liveIn('work', 'api'), [`live/${ID_B}`]: liveIn('fork', 'api') })
})

test('case 3, two live sessions in /a/work/api and /b/work/api: the parent folders share a name too, so each title adds its own tag', async ($, on) => {
  const { ran, session, store } = engineBottom(on, {}, { id: ID_A, root: '/a/work/api' })
  await $.session.start(START)
  answerAs(session, ID_B, '/b/work/api')
  await $.session.start(START)
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api · 9b1c"')

  answerAs(session, ID_A, '/a/work/api')
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api · 3f2a"')
  expect(store).toEqual({ [`live/${ID_A}`]: liveIn('work', 'api'), [`live/${ID_B}`]: liveIn('work', 'api') })
})

test('three live sessions in /a/work/api, /b/work/api and /c/fork/api: two tags, and `fork/api`', async ($, on) => {
  const { ran, session } = engineBottom(on, {}, { id: ID_A, root: '/a/work/api' })
  const sessions = [
    [ID_A, '/a/work/api'],
    [ID_B, '/b/work/api'],
    [ID_C, '/c/fork/api'],
  ] as const
  for (const [id, root] of sessions) {
    answerAs(session, id, root)
    await $.session.start(START)
  }
  const titles: (string | undefined)[] = []
  for (const [id, root] of sessions) {
    answerAs(session, id, root)
    await permission($)
    titles.push(lastScript(ran))
  }

  expect(titles).toEqual([
    'display notification "Waiting on a permission" with title "Claude needs you · api · 3f2a"',
    'display notification "Waiting on a permission" with title "Claude needs you · api · 9b1c"',
    'display notification "Waiting on a permission" with title "Claude needs you · fork/api"',
  ])
})

test('a same-name record from an older build has no parent: it matches no parent, so this title says `work/api`', async ($, on) => {
  const { ran, store } = engineBottom(on, {}, { id: ID_A, root: '/x/work/api', store: { [`live/${ID_B}`]: live('api') } })
  await $.session.start(START)
  await permission($)

  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · work/api"')
  // The older record is still a live session's: kept, as it was.
  expect(store).toEqual({ [`live/${ID_B}`]: live('api'), [`live/${ID_A}`]: liveIn('work', 'api') })
})

test('a live session whose folder has another name: the folder name alone', async ($, on) => {
  const { ran } = engineBottom(on, {}, { id: ID_A, root: '/a/api', store: { [`live/${ID_B}`]: live('web') } })
  await permission($)

  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api"')
})

test('a same-name record not touched for over 24 hours is stale: the folder name alone, and the record is removed', async ($, on) => {
  const { ran, store } = engineBottom(on, {}, {
    id: ID_A,
    root: '/a/api',
    store: { [`live/${ID_B}`]: live('api', NOW - LIVE_TTL_MS - 1), [`live/${ID_C}`]: live('web', NOW - 2 * LIVE_TTL_MS) },
  })
  await permission($)

  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api"')
  expect(Object.keys(store)).toEqual([`live/${ID_A}`])
})

test('no session id, or no project root: the plain `Claude needs you`, and nothing written to the store', async ($, on) => {
  const { clock, ran, session, store } = engineBottom(on, { config: '{ "notify_on_stop": true }' }, {
    store: { [`live/${ID_B}`]: live('api') },
  })
  const missing: Session[] = [{ root: '/work/api' }, { id: ID_A }, { id: ID_A, root: '/' }, { id: '', root: '/work/api' }]
  for (const host of missing) {
    session.id = host.id
    session.root = host.root
    await $.session.start(START)
    await $.prompt.submit(typed('carry on'))
    await clock.settle()
    await permission($)
    expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))
    await clock.advance(3 * MIN)
    expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
    await $.turn.complete(finish('turn-1'))
    expect(ran.at(-1)).toEqual(notifyArgv(STOP_BODY))
  }

  expect(posted(ran)).toHaveLength(3 * missing.length)
  expect(Object.keys(store)).toEqual([`live/${ID_B}`])
})

test('when the store keys cannot be read: the plain `Claude needs you`, not the folder name', async ($, on) => {
  const { ran, storeFail } = engineBottom(on, {}, { id: ID_A, root: '/work/api' })
  storeFail.keys = new Error('store keys failed')
  await permission($)
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))
})

test('when a live record cannot be read: the plain `Claude needs you`, not the folder name', async ($, on) => {
  const { ran, storeFail } = engineBottom(on, {}, {
    id: ID_A,
    root: '/work/api',
    store: { [`live/${ID_B}`]: live('api') },
  })
  storeFail.get = new Error('store get failed')
  await permission($)
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))
})

test("the session's record: the folder's name and its parent's only, written at start, refreshed by your prompt and the main turn's end, removed at session end", async ($, on) => {
  const { clock, store } = engineBottom(on, {}, {
    id: ID_A,
    root: '/Users/ada/clients/acme/api',
    store: { [`live/${ID_B}`]: live('web') },
  })
  const own = { key: `live/${ID_A}` }
  await $.session.start(START)
  expect(store[own.key]).toEqual({ v: 1, name: 'api', parent: 'acme', seenAt: NOW })

  await clock.advance(2 * HOUR)
  await $.prompt.submit({ text: 'Background task done', wait: false, origin: { kind: 'task-notification' } })
  await clock.settle()
  expect(store[own.key]).toEqual(liveIn('acme', 'api', NOW))
  await $.prompt.submit(typed('carry on'))
  await clock.settle()
  expect(store[own.key]).toEqual(liveIn('acme', 'api', NOW + 2 * HOUR))

  await clock.advance(1 * HOUR)
  await $.turn.complete(finish('turn-sub', { agentId: 'agent-1' }))
  expect(store[own.key]).toEqual(liveIn('acme', 'api', NOW + 2 * HOUR))
  await $.turn.complete(finish('turn-1', { isAborted: true }))
  expect(store[own.key]).toEqual(liveIn('acme', 'api', NOW + 3 * HOUR))

  await $.session.end({ reason: 'prompt_input_exit', sessionId: ID_A, resume: { id: ID_A } })
  expect(Object.keys(store)).toEqual([`live/${ID_B}`])
})

test("/clear: the ending session's record goes, and the next prompt you send writes the new session's", async ($, on) => {
  const { clock, session, store } = engineBottom(on, {}, { id: ID_A, root: '/work/api' })
  await $.session.start(START)
  expect(Object.keys(store)).toEqual([`live/${ID_A}`])

  await $.session.end({ reason: 'clear', sessionId: ID_A, resume: { id: ID_A } })
  expect(Object.keys(store)).toEqual([])

  // The process goes on under a new id, and no session.start fires for it.
  session.id = ID_C
  await $.prompt.submit(typed('start over'))
  await clock.settle()
  expect(Object.keys(store)).toEqual([`live/${ID_C}`])
})

test('the reminder keeps the title of the notification it follows, even when a same-name session starts in between', async ($, on) => {
  const { clock, ran, store } = engineBottom(on, {}, { id: ID_A, root: '/x/work/api' })
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · api"')

  store[`live/${ID_B}`] = liveIn('fork', 'api')
  await clock.advance(3 * MIN)
  expect(lastScript(ran)).toBe('display notification "Still waiting · 3 min" with title "Claude needs you · api"')

  // The next wait looks again, and now there is a twin in another parent folder.
  await permission($)
  expect(lastScript(ran)).toBe('display notification "Waiting on a permission" with title "Claude needs you · work/api"')
})

test('with no same-name session, only the folder name reaches a notification: not its parent or the path above, your prompt, a tool call or the transcript', async ($, on) => {
  const { clock, ran, store } = engineBottom(on, {}, { id: ID_A, root: '/Users/ada/clients/acme-payroll/api' })
  const opened = { transcript: 0, fetch: 0 }
  on('session.messages', () => {
    opened.transcript += 1
    throw new Error('wait-notify reads no transcript')
  })
  on('http.fetch', () => {
    opened.fetch += 1
    throw new Error('wait-notify opens no connection')
  })
  await $.session.start(START)
  await $.prompt.submit(typed('rotate the acme payroll key'))
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'vault write secret/acme-payroll key=hunter2' })
  await permission($)
  await clock.advance(3 * MIN)

  const scripts = posted(ran).map(argv => argv[2] ?? '')
  expect(scripts).toHaveLength(2)
  for (const script of scripts) {
    expect(script.endsWith(' with title "Claude needs you · api"')).toBe(true)
    for (const word of ['Users', 'ada', 'clients', 'acme', 'payroll', 'rotate', 'vault', 'hunter2']) {
      expect(script.includes(word)).toBe(false)
    }
  }
  // The record keeps the parent's name for the next session named api, and nothing above it.
  expect(store[`live/${ID_A}`]).toEqual(liveIn('acme-payroll', 'api', NOW))
  expect(opened).toEqual({ transcript: 0, fetch: 0 })
})

test("with a same-name session in another parent folder, the parent folder's name reaches the title, and nothing above it", async ($, on) => {
  const { clock, ran, store } = engineBottom(on, {}, {
    id: ID_A,
    root: '/Users/ada/clients/acme-payroll/api',
    store: { [`live/${ID_B}`]: liveIn('web-team', 'api') },
  })
  await $.session.start(START)
  await $.prompt.submit(typed('rotate the acme payroll key'))
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'vault write secret/acme-payroll key=hunter2' })
  await permission($)
  await clock.advance(3 * MIN)

  const calls = posted(ran)
  expect(calls.map(argv => argv[2])).toEqual([
    'display notification "Waiting on a permission" with title "Claude needs you · acme-payroll/api"',
    'display notification "Still waiting · 3 min" with title "Claude needs you · acme-payroll/api"',
  ])
  // Every part of every osascript call, not only the script: nothing above the parent folder.
  for (const part of calls.flat()) {
    for (const word of ['Users', 'ada', 'clients', 'rotate', 'vault', 'hunter2']) {
      expect(part.includes(word)).toBe(false)
    }
  }
  expect(store[`live/${ID_A}`]).toEqual(liveIn('acme-payroll', 'api', NOW))
  for (const word of ['Users', 'ada', 'clients']) {
    expect(JSON.stringify(store).includes(word)).toBe(false)
  }
})
