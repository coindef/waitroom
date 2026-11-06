import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import {
  FRONTMOST_ARGV,
  FRONTMOST_SCRIPT,
  IOREG_ARGV,
  notifyArgv,
  PERMISSION_BODY,
  QUESTION_BODY,
  reminderBody,
  STOP_BODY,
} from '../hooks/notify'

/**
 * The whole loop through the engine: Notification events, tool calls, prompts
 * and turn ends raised as Claude Code raises them, `process.run` answered by
 * a pretend Mac, the config file by the test's `fs.read`, and the reminder's
 * timer by the mock clock. Nothing here is spawned or posted for real.
 */

const HOME = '/Users/ada'
const CONFIG = `${HOME}/.waitroom/notify.json`
const MIN = 60_000

const SAFARI = '/Applications/Safari.app/'
const ITERM = '/Applications/iTerm.app/'

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

/** Nothing sits beneath the plugin in a test, so the test stands in for the engine and the Mac. */
const engineBottom = (on: On, start: Partial<Mac> = {}) => {
  const mac: Mac = { uname: 'Darwin', idleSeconds: 1, front: SAFARI, ...start }
  const clock = mock.clock(on)
  mock.env(on, mac.noHome ? {} : { HOME })
  const ran: string[][] = []
  const read: string[] = []
  /** Tool calls held open this long on the clock: a dialog answered that much later. */
  const holds: Partial<Record<string, number>> = {}
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

  return { clock, mac, ran, read, holds }
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
