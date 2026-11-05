import { expect, test } from 'claude-code/testing'

import {
  appleString,
  bodyOf,
  checkPresence,
  configOf,
  configPathOf,
  createNotifier,
  DEFAULT_CONFIG,
  FRONTMOST_ARGV,
  FRONTMOST_SCRIPT,
  frontmostAppOf,
  idleSecondsOf,
  IOREG_ARGV,
  isPersonPrompt,
  isPresent,
  isTerminalApp,
  notificationTypeOf,
  notifyArgv,
  NOTIFY_TITLE,
  type NotifyHost,
  PERMISSION_BODY,
  platformOfUname,
  QUESTION_BODY,
  reminderBody,
  type RunResult,
  STOP_BODY,
  waitKindOf,
} from '../hooks/notify'

const SAFARI = '/Applications/Safari.app/'
const ITERM = '/Applications/iTerm.app/'

type Timer = { ms: number; fn: () => Promise<void>; isCancelled: boolean }

/** A host whose commands `answer` answers, whose timers fire only when the test says, and whose config is `config`. */
const fakeHost = (answer: (argv: readonly string[]) => RunResult | undefined, config?: string) => {
  const ran: string[][] = []
  const timers: Timer[] = []
  const host: NotifyHost = {
    run: async argv => {
      ran.push([...argv])

      return answer(argv)
    },
    after: (ms, fn) => {
      const timer: Timer = { ms, fn, isCancelled: false }
      timers.push(timer)

      return {
        cancel: () => {
          timer.isCancelled = true
        },
      }
    },
    readConfig: async () => config,
  }
  /** Every timer not cancelled fires, as the clock reaching it would. */
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.isCancelled) await timer.fn()
  }

  return { host, ran, timers, fire }
}

/** A Mac with this idle time and this app in front. */
const mac =
  (idleSeconds: number, front: string, uname = 'Darwin') =>
  (argv: readonly string[]): RunResult | undefined => {
    if (argv[0] === 'uname') return { exitCode: 0, stdout: `${uname}\n` }
    if (argv[0] === 'ioreg') return { exitCode: 0, stdout: `    "HIDIdleTime" = ${Math.round(idleSeconds * 1e9)}\n` }
    if (argv[2] === FRONTMOST_SCRIPT) return { exitCode: 0, stdout: `${front}\n` }

    return { exitCode: 0, stdout: '' }
  }

/** `uname`, the presence check of someone away, then the notification. */
const NOTIFIED_AFTER_UNAME = [['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(PERMISSION_BODY)]

test('the copy is locked: title, the two bodies, the reminder with its minutes', () => {
  expect(NOTIFY_TITLE).toBe('Claude needs you')
  expect(PERMISSION_BODY).toBe('Waiting on a permission')
  expect(QUESTION_BODY).toBe('Asked you a question')
  expect(reminderBody(3)).toBe('Still waiting · 3 min')
  expect(reminderBody(10)).toBe('Still waiting · 10 min')
  expect(bodyOf('permission')).toBe(PERMISSION_BODY)
  expect(bodyOf('question')).toBe(QUESTION_BODY)
  expect(STOP_BODY).toBe('Finished · your turn')
})

test('no file, or one that is not a JSON object, is every default', () => {
  expect(DEFAULT_CONFIG).toEqual({ presentIdleSecs: 30, remindAfterMin: 3, notifyOnStop: false })
  for (const text of [undefined, '', 'not json', '{ "remind_after_min": 1,', 'null', '[]', '[1, 2]', '"text"', '42']) {
    expect(configOf(text)).toEqual(DEFAULT_CONFIG)
  }
})

test('each key is read on its own: a missing, mistyped or out-of-range one keeps its default', () => {
  expect(configOf('{ "present_idle_secs": 60, "remind_after_min": 5, "notify_on_stop": true }')).toEqual({
    presentIdleSecs: 60,
    remindAfterMin: 5,
    notifyOnStop: true,
  })
  expect(configOf('{ "remind_after_min": 1 }')).toEqual({ ...DEFAULT_CONFIG, remindAfterMin: 1 })
  expect(configOf('{ "present_idle_secs": "60", "remind_after_min": 0, "notify_on_stop": "yes" }')).toEqual(
    DEFAULT_CONFIG,
  )
  expect(configOf('{ "present_idle_secs": -5, "remind_after_min": null }')).toEqual(DEFAULT_CONFIG)
  expect(configOf('{ "present_idle_secs": 86401, "remind_after_min": 1441 }')).toEqual(DEFAULT_CONFIG)
  expect(configOf('{ "present_idle_secs": 86400, "remind_after_min": 1440 }')).toEqual({
    ...DEFAULT_CONFIG,
    presentIdleSecs: 86_400,
    remindAfterMin: 1_440,
  })
  expect(configOf('{ "notify_on_stop": 1, "sound": true }')).toEqual(DEFAULT_CONFIG)
  expect(configOf('﻿{ "notify_on_stop": true }').notifyOnStop).toBe(true)
})

test('the config path is under HOME, with or without a trailing slash', () => {
  expect(configPathOf('/Users/ada')).toBe('/Users/ada/.waitroom/notify.json')
  expect(configPathOf('/Users/ada/')).toBe('/Users/ada/.waitroom/notify.json')
  expect(configPathOf('/')).toBe('/.waitroom/notify.json')
})

test('only uname Darwin is macOS', () => {
  expect(platformOfUname('Darwin\n')).toBe('darwin')
  expect(platformOfUname('Linux\n')).toBe('other')
  expect(platformOfUname('FreeBSD')).toBe('other')
  expect(platformOfUname('MINGW64_NT-10.0')).toBe('other')
  expect(platformOfUname('')).toBe('other')
})

test('HIDIdleTime is nanoseconds, read from the first line that has it', () => {
  const ioreg = [
    '+-o IOHIDSystem  <class IOHIDSystem, id 0x1000004c9, registered, matched, active, busy 0 (0 ms), retain 23>',
    '    {',
    '      "IOClass" = "IOHIDSystem"',
    '      "HIDIdleTime" = 2500000000',
    '      "HIDParameters" = {"HIDClickTime"=500000000}',
    '    }',
    '      "HIDIdleTime" = 99000000000',
  ].join('\n')

  expect(idleSecondsOf(ioreg)).toBe(2.5)
  expect(idleSecondsOf('"HIDIdleTime"=0')).toBe(0)
  expect(idleSecondsOf('"HIDIdleTime" = 604800000000000')).toBe(604_800)
  expect(idleSecondsOf('')).toBeUndefined()
  expect(idleSecondsOf('"HIDClickTime" = 500000000')).toBeUndefined()
})

test('the frontmost app is the bundle name off its path, or a bare name as given', () => {
  expect(frontmostAppOf('/Applications/iTerm.app/\n')).toBe('iTerm')
  expect(frontmostAppOf('/System/Applications/Utilities/Terminal.app/')).toBe('Terminal')
  expect(frontmostAppOf('/Applications/Visual Studio Code.app/')).toBe('Visual Studio Code')
  expect(frontmostAppOf('/Users/ada/Applications/Cursor.app')).toBe('Cursor')
  expect(frontmostAppOf('Code\n')).toBe('Code')
  expect(frontmostAppOf('')).toBe('')
})

test('Terminal, iTerm2, Ghostty, VS Code and Cursor are terminals, by bundle or process name; nothing else is', () => {
  for (const name of [
    'Terminal',
    'iTerm',
    'iTerm2',
    'Ghostty',
    'ghostty',
    'Visual Studio Code',
    'Visual Studio Code - Insiders',
    'Code',
    'Electron',
    'Cursor',
  ]) {
    expect(isTerminalApp(name)).toBe(true)
  }
  for (const name of ['Safari', 'Google Chrome', 'Finder', 'Slack', 'Script Editor', 'Terminal Notes', '']) {
    expect(isTerminalApp(name)).toBe(false)
  }
})

test('present needs both: idle under the threshold, and a terminal in front', () => {
  expect(isPresent(2, 'iTerm', 30)).toBe(true)
  expect(isPresent(29.9, 'Terminal', 30)).toBe(true)
  expect(isPresent(30, 'Terminal', 30)).toBe(false)
  expect(isPresent(2, 'Safari', 30)).toBe(false)
  expect(isPresent(undefined, 'iTerm', 30)).toBe(false)
  expect(isPresent(2, undefined, 30)).toBe(false)
  expect(isPresent(45, 'Cursor', 60)).toBe(true)
})

test('permission_prompt is a permission, or a question while AskUserQuestion is open; elicitation_dialog is a question; the rest is nothing', () => {
  expect(waitKindOf('permission_prompt', false)).toBe('permission')
  expect(waitKindOf('permission_prompt', true)).toBe('question')
  expect(waitKindOf('elicitation_dialog', false)).toBe('question')
  for (const type of ['idle_prompt', 'auth_success', 'elicitation_url_dialog', 'worker_permission_prompt', undefined]) {
    expect(waitKindOf(type, false)).toBeNull()
    expect(waitKindOf(type, true)).toBeNull()
  }
  expect(notificationTypeOf({ notification_type: 'permission_prompt' })).toBe('permission_prompt')
  expect(notificationTypeOf({})).toBeUndefined()
})

test('only a prompt you typed, or sent from your phone or the web, is you', () => {
  expect(isPersonPrompt({ kind: 'composer' })).toBe(true)
  expect(isPersonPrompt({ kind: 'bridge' })).toBe(true)
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'sdk', 'channel']) {
    expect(isPersonPrompt({ kind })).toBe(false)
  }
  expect(isPersonPrompt(undefined)).toBe(false)
})

test('the notification is one osascript call, silent, with quotes kept inside its one script argument', () => {
  expect(notifyArgv(PERMISSION_BODY)).toEqual([
    'osascript',
    '-e',
    'display notification "Waiting on a permission" with title "Claude needs you"',
  ])
  expect(notifyArgv(reminderBody(3))[2]).not.toContain('sound name')
  expect(appleString('say "hi" \\ now\nplease')).toBe('"say \\"hi\\" \\\\ now please"')
  expect(IOREG_ARGV).toEqual(['ioreg', '-c', 'IOHIDSystem'])
  expect(FRONTMOST_ARGV).toEqual(['osascript', '-e', 'POSIX path of (path to frontmost application)'])
  for (const argv of [notifyArgv(QUESTION_BODY), IOREG_ARGV, FRONTMOST_ARGV]) {
    expect(argv.some(part => part === 'sh' || part === 'bash' || part.includes('http'))).toBe(false)
  }
})

test('the presence check asks the frontmost app only when idle is under the threshold, and a failed command is away', async () => {
  const idle = fakeHost(mac(31, ITERM))
  expect(await checkPresence(idle.host, 30)).toBe(false)
  expect(idle.ran).toEqual([IOREG_ARGV])

  const here = fakeHost(mac(3, ITERM))
  expect(await checkPresence(here.host, 30)).toBe(true)
  expect(here.ran).toEqual([IOREG_ARGV, FRONTMOST_ARGV])

  const noIoreg = fakeHost(argv => (argv[0] === 'ioreg' ? undefined : mac(3, ITERM)(argv)))
  expect(await checkPresence(noIoreg.host, 30)).toBe(false)
  expect(noIoreg.ran).toEqual([IOREG_ARGV])

  const refused = fakeHost(argv => (argv[2] === FRONTMOST_SCRIPT ? { exitCode: 1, stdout: '' } : mac(3, ITERM)(argv)))
  expect(await checkPresence(refused.host, 30)).toBe(false)
})

test('away: one notification, one timer at the configured minutes, one reminder, then none', async () => {
  const notifier = createNotifier()
  const { host, ran, timers, fire } = fakeHost(mac(1, SAFARI), '{ "remind_after_min": 2 }')
  await notifier.notification(host, 'permission_prompt')

  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(PERMISSION_BODY)])
  expect(timers.map(timer => timer.ms)).toEqual([2 * 60_000])

  await fire()
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(reminderBody(2))])
  await fire()
  expect(ran).toHaveLength(7)
  expect(timers).toEqual([])
})

test('an answer that lands while the presence check runs: no notification and no reminder', async () => {
  const notifier = createNotifier()
  const { host, ran, timers } = fakeHost(argv => {
    if (argv[0] === 'ioreg') notifier.clear()

    return mac(1, SAFARI)(argv)
  })
  await notifier.notification(host, 'permission_prompt')

  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV])
  expect(timers).toEqual([])
})

test('an answer that lands while the notification posts: no reminder', async () => {
  const notifier = createNotifier()
  const { host, timers } = fakeHost(argv => {
    if (argv[2]?.startsWith('display notification ')) notifier.clear()

    return mac(1, SAFARI)(argv)
  })
  await notifier.notification(host, 'permission_prompt')

  expect(timers).toEqual([])
})

test('a tool call already running when the wait began ends it; one that started after does not', async () => {
  const notifier = createNotifier()
  const { host, timers } = fakeHost(mac(1, SAFARI))
  const waiting = notifier.toolStarted('Bash')
  await notifier.notification(host, 'permission_prompt')

  notifier.toolSettled(notifier.toolStarted('Read'), 'Read')
  expect(timers[0]?.isCancelled).toBe(false)

  notifier.toolSettled(waiting, 'Bash')
  expect(timers[0]?.isCancelled).toBe(true)
})

test('while AskUserQuestion is open the body is the question; once it ends, a permission again', async () => {
  const notifier = createNotifier()
  const { host, ran } = fakeHost(mac(1, SAFARI))
  const asking = notifier.toolStarted('AskUserQuestion')
  await notifier.notification(host, 'permission_prompt')
  expect(ran.at(-1)).toEqual(notifyArgv(QUESTION_BODY))

  notifier.toolSettled(asking, 'AskUserQuestion')
  await notifier.notification(host, 'permission_prompt')
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))
})

test('not macOS: uname once for the session, then nothing at all; a uname that failed is asked again', async () => {
  const notifier = createNotifier()
  const linux = fakeHost(mac(1, SAFARI, 'Linux'), '{ "notify_on_stop": true }')
  await notifier.notification(linux.host, 'permission_prompt')
  await notifier.notification(linux.host, 'elicitation_dialog')
  await notifier.turnEnded(linux.host)
  expect(linux.ran).toEqual([['uname']])
  expect(linux.timers).toEqual([])

  const flaky = createNotifier()
  let failures = 1
  const shaky = fakeHost(argv => {
    if (argv[0] === 'uname' && failures > 0) {
      failures -= 1

      return undefined
    }

    return mac(1, SAFARI)(argv)
  })
  await flaky.notification(shaky.host, 'permission_prompt')
  expect(shaky.ran).toEqual([['uname']])
  await flaky.notification(shaky.host, 'permission_prompt')
  expect(shaky.ran.slice(1)).toEqual(NOTIFIED_AFTER_UNAME)
})

test('a turn end runs nothing by default; with notify_on_stop it notifies only when you are away', async () => {
  const quiet = fakeHost(mac(1, SAFARI))
  await createNotifier().turnEnded(quiet.host)
  expect(quiet.ran).toEqual([])

  const away = fakeHost(mac(1, SAFARI), '{ "notify_on_stop": true }')
  await createNotifier().turnEnded(away.host)
  expect(away.ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(STOP_BODY)])
  expect(away.timers).toEqual([])

  const here = fakeHost(mac(1, ITERM), '{ "notify_on_stop": true }')
  await createNotifier().turnEnded(here.host)
  expect(here.ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV])
})
