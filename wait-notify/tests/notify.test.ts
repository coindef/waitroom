import { expect, test } from 'claude-code/testing'

import {
  appleString,
  bodyOf,
  checkPresence,
  configOf,
  configPathOf,
  createNotifier,
  DEFAULT_CONFIG,
  folderNameOf,
  FRONTMOST_ARGV,
  FRONTMOST_SCRIPT,
  frontmostAppOf,
  idleSecondsOf,
  IOREG_ARGV,
  isPersonPrompt,
  isPresent,
  isTerminalApp,
  LIVE_PREFIX,
  LIVE_TTL_MS,
  liveEntryOf,
  liveKeyOf,
  liveRecordOf,
  MAX_FOLDER_GRAPHEMES,
  notificationTypeOf,
  notifyArgv,
  NOTIFY_TITLE,
  type NotifyHost,
  peersOf,
  PERMISSION_BODY,
  platformOfUname,
  QUESTION_BODY,
  recheckIdleSecs,
  reminderBody,
  type RunResult,
  sessionLabel,
  STOP_BODY,
  tagOf,
  titleOf,
  waitKindOf,
} from '../hooks/notify'

const SAFARI = '/Applications/Safari.app/'
const ITERM = '/Applications/iTerm.app/'

/** Two host session ids, as Claude Code names a session: a uuid. */
const ID_A = '3f2a6c1e-8d4b-4f0a-9e2d-5b7c1a0e9f31'
const ID_B = '9b1c0d2e-4a5f-4c3b-8e7d-1f2a3b4c5d6e'

type Timer = { ms: number; fn: () => Promise<void>; isCancelled: boolean }

/**
 * A host whose commands `answer` answers, whose timers fire only when the test
 * says, whose config is `config`, and whose session label is `label`'s answer
 * (none by default: the plain title).
 */
const fakeHost = (
  answer: (argv: readonly string[]) => RunResult | undefined,
  config?: string,
  label: () => Promise<string | undefined> = async () => undefined,
) => {
  const ran: string[][] = []
  const timers: Timer[] = []
  const lookups = { count: 0 }
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
    label: async () => {
      lookups.count += 1

      return label()
    },
  }
  /** Every timer not cancelled fires, as the clock reaching it would. */
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.isCancelled) await timer.fn()
  }

  return { host, ran, timers, fire, lookups }
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

test('the recheck looks back over the whole wait, or present_idle_secs when that is longer', () => {
  expect(recheckIdleSecs(DEFAULT_CONFIG)).toBe(3 * 60)
  expect(recheckIdleSecs({ ...DEFAULT_CONFIG, remindAfterMin: 10 })).toBe(10 * 60)
  expect(recheckIdleSecs({ ...DEFAULT_CONFIG, remindAfterMin: 0.25 })).toBe(30)
  expect(recheckIdleSecs({ ...DEFAULT_CONFIG, presentIdleSecs: 900 })).toBe(900)
})

test('a key since the notification, with a terminal in front at the recheck: no reminder', async () => {
  const notifier = createNotifier()
  const you = { idleSeconds: 1, front: SAFARI }
  const { host, ran, timers, fire } = fakeHost(argv => mac(you.idleSeconds, you.front)(argv))
  await notifier.notification(host, 'permission_prompt')
  expect(ran).toEqual(NOTIFIED_AFTER_UNAME)

  // You allowed it at the terminal 20 seconds in, then left.
  you.front = ITERM
  you.idleSeconds = 3 * 60 - 20
  await fire()
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV])
  expect(timers).toEqual([])
})

test('no key since the notification, or another app in front at the recheck: the reminder', async () => {
  const gone = createNotifier()
  const left = { idleSeconds: 45, front: ITERM }
  const idle = fakeHost(argv => mac(left.idleSeconds, left.front)(argv))
  await gone.notification(idle.host, 'permission_prompt')
  left.idleSeconds = 45 + 3 * 60
  await idle.fire()
  expect(idle.ran.slice(3)).toEqual([IOREG_ARGV, notifyArgv(reminderBody(3))])

  const busy = createNotifier()
  const elsewhere = fakeHost(mac(2, SAFARI))
  await busy.notification(elsewhere.host, 'permission_prompt')
  await elsewhere.fire()
  expect(elsewhere.ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(reminderBody(3))])
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

test('the folder name is the last part of the root, and nothing above it', () => {
  expect(folderNameOf('/Users/ada/work/api')).toBe('api')
  expect(folderNameOf('/Users/ada/work/api/')).toBe('api')
  expect(folderNameOf('/Users/ada/work/api//')).toBe('api')
  expect(folderNameOf('/Users/ada/Client Work/my app')).toBe('my app')
  expect(folderNameOf('C:\\Users\\ada\\api')).toBe('api')
  expect(folderNameOf('api')).toBe('api')
  for (const root of ['/', '//', '', '   ', '/work/.', '/work/..', undefined, null, 42, {}, ['/work/api']]) {
    expect(folderNameOf(root)).toBeUndefined()
  }
})

test('control characters in a folder name: ANSI, C0, DEL, C1 and invisible ones are dropped, never shown', () => {
  expect(folderNameOf('/work/\u001b[31mapi\u001b[0m')).toBe('api')
  expect(folderNameOf('/work/\u001b]0;pwned\u0007api')).toBe('api')
  expect(folderNameOf('/work/a\u0000p\u0007i')).toBe('api')
  expect(folderNameOf('/work/api\nprod\r\t')).toBe('apiprod')
  expect(folderNameOf('/work/api\u007f\u0085\u009b')).toBe('api')
  expect(folderNameOf('/work/a\u200bp\u200ci\ufeff')).toBe('api')
  expect(folderNameOf('/work/\u202eipa\u2066')).toBe('ipa')
  expect(folderNameOf('/work/api\u2028two')).toBe('apitwo')
  expect(folderNameOf('/work/  api  ')).toBe('api')
  expect(folderNameOf('/work/\u001b[2J\u0007\u200b')).toBeUndefined()
  // The joiner inside an emoji stays: it is part of the character.
  expect(folderNameOf('/work/👩‍💻 tools')).toBe('👩‍💻 tools')
  // One form for one name, so two sessions' names compare equal.
  expect(folderNameOf('/work/cafe\u0301')).toBe('caf\u00e9')
})

test('truncation: past 20 graphemes the folder name is cut on a grapheme boundary and ends in …', () => {
  expect(MAX_FOLDER_GRAPHEMES).toBe(20)
  const twenty = 'abcdefghijklmnopqrst'
  expect(folderNameOf(`/work/${twenty}`)).toBe(twenty)
  expect(folderNameOf(`/work/${twenty}u`)).toBe('abcdefghijklmnopqrs…')
  // A space the cut lands on is not kept before the ellipsis.
  expect(folderNameOf('/work/my project name is long')).toBe('my project name is…')
  // A family is one grapheme of seven code points: the cut never splits it.
  const family = '👨‍👩‍👧‍👦'
  expect(folderNameOf(`/work/${'a'.repeat(18)}${family}xyz`)).toBe(`${'a'.repeat(18)}${family}…`)
  expect(folderNameOf(`/work/${family.repeat(20)}`)).toBe(family.repeat(20))
  expect(folderNameOf(`/work/${family.repeat(21)}`)).toBe(`${family.repeat(19)}…`)
})

test("the tag: the id's first 4 letters and digits, longer only while a same-name peer's id starts the same, at most 8", () => {
  expect(tagOf(ID_A, [])).toBe('3f2a')
  expect(tagOf(ID_A, [ID_B])).toBe('3f2a')
  expect(tagOf('3F2A-6C1E', [])).toBe('3f2a')
  expect(tagOf('3f2a6c1e', ['3f2a7b40'])).toBe('3f2a6')
  expect(tagOf('3f2a6c1e', ['3F2A-6C9F'])).toBe('3f2a6c1')
  expect(tagOf('3f2a6c1e', ['3f2a7b40', '3f2a6d00'])).toBe('3f2a6c')
  expect(tagOf('3f2a6c1e00', ['3f2a6c1e11'])).toBe('3f2a6c1e')
  expect(tagOf('ab', [])).toBe('ab')
})

test("same-name collision: the label is the folder name, with this session's tag while a live peer's folder has the same name", () => {
  const self = { id: ID_A, root: '/a/api' }
  expect(sessionLabel(self, [])).toBe('api')
  expect(sessionLabel(self, [{ id: ID_B, name: 'web' }])).toBe('api')
  expect(sessionLabel(self, [{ id: ID_B, name: 'api' }])).toBe('api · 3f2a')
  expect(sessionLabel({ id: ID_B, root: '/b/api' }, [{ id: ID_A, name: 'api' }])).toBe('api · 9b1c')
  // Its own record is not a peer.
  expect(sessionLabel(self, [{ id: ID_A, name: 'api' }])).toBe('api')
  // Ids that start the same: a longer tag on each side, never the same one.
  const near = '3f2a7b40-0000-4000-8000-000000000000'
  expect(sessionLabel(self, [{ id: near, name: 'api' }])).toBe('api · 3f2a6')
  expect(sessionLabel({ id: near, root: '/b/api' }, [{ id: ID_A, name: 'api' }])).toBe('api · 3f2a7')
})

test('missing id or missing root: no label and no live record, never a guess', () => {
  const peers = [{ id: ID_B, name: 'api' }]
  for (const id of [undefined, null, '', '   ', '----', 42, {}]) {
    expect(sessionLabel({ id, root: '/a/api' }, peers)).toBeUndefined()
    expect(liveRecordOf({ id, root: '/a/api' }, 1)).toBeUndefined()
  }
  for (const root of [undefined, null, '', '/', '/a/\u0007', 42]) {
    expect(sessionLabel({ id: ID_A, root }, peers)).toBeUndefined()
    expect(liveRecordOf({ id: ID_A, root }, 1)).toBeUndefined()
  }
})

test('a long folder name with a tag: the name is cut, the tag never', () => {
  const long = 'payments-service-frontend'
  const cut = 'payments-service-fr…'
  expect(folderNameOf(`/a/${long}`)).toBe(cut)
  expect(sessionLabel({ id: ID_A, root: `/a/${long}` }, [{ id: ID_B, name: cut }])).toBe(`${cut} · 3f2a`)
  // Two names that differ only past the cut look the same in a title, so they get tags too.
  expect(sessionLabel({ id: ID_A, root: '/a/payments-service-fridge' }, [{ id: ID_B, name: cut }])).toBe(`${cut} · 3f2a`)
  expect(sessionLabel({ id: '3f2a6c1e00', root: `/a/${long}` }, [{ id: '3f2a6c1e11', name: cut }])).toBe(
    `${cut} · 3f2a6c1e`,
  )
})

test('a cleaned folder name is what the label shows, what the record keeps, and what a twin is matched on', () => {
  const dirty = { id: ID_A, root: '/a/\u001b[31mapi\u001b[0m\u0007' }
  expect(sessionLabel(dirty, [])).toBe('api')
  expect(sessionLabel(dirty, [{ id: ID_B, name: 'api' }])).toBe('api · 3f2a')
  expect(liveRecordOf(dirty, 5)).toEqual({ key: `live/${ID_A}`, entry: { v: 1, name: 'api', seenAt: 5 } })
})

test('the title is `Claude needs you`, then the label when there is one', () => {
  expect(titleOf(undefined)).toBe(NOTIFY_TITLE)
  expect(titleOf('')).toBe('Claude needs you')
  expect(titleOf('api')).toBe('Claude needs you · api')
  expect(titleOf('api · 3f2a')).toBe('Claude needs you · api · 3f2a')
})

test('with a label the title is still one AppleScript string: quotes and backslashes stay inside it', () => {
  expect(notifyArgv(PERMISSION_BODY)).toEqual([
    'osascript',
    '-e',
    'display notification "Waiting on a permission" with title "Claude needs you"',
  ])
  expect(notifyArgv(PERMISSION_BODY, 'api · 3f2a')).toEqual([
    'osascript',
    '-e',
    'display notification "Waiting on a permission" with title "Claude needs you · api · 3f2a"',
  ])
  expect(notifyArgv(QUESTION_BODY, folderNameOf('/work/the "best" app'))[2]).toBe(
    'display notification "Asked you a question" with title "Claude needs you · the \\"best\\" app"',
  )
  expect(notifyArgv(PERMISSION_BODY, 'a\\" & do shell script "x')[2]).toBe(
    'display notification "Waiting on a permission" with title "Claude needs you · a\\\\\\" & do shell script \\"x"',
  )
})

test('a live record is { v: 1, name, seenAt } under live/ and the session id; anything else is no record', () => {
  expect(LIVE_PREFIX).toBe('live/')
  expect(LIVE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  expect(liveKeyOf(ID_A)).toBe(`live/${ID_A}`)
  expect(liveKeyOf(` ${ID_A}\n`)).toBe(`live/${ID_A}`)
  expect(liveKeyOf('')).toBeUndefined()
  expect(liveRecordOf({ id: ID_A, root: '/a/api/' }, 1234)).toEqual({
    key: `live/${ID_A}`,
    entry: { v: 1, name: 'api', seenAt: 1234 },
  })
  expect(liveEntryOf({ v: 1, name: 'api', seenAt: 5 })).toEqual({ v: 1, name: 'api', seenAt: 5 })
  expect(liveEntryOf({ v: 1, name: 'api', seenAt: 5, path: '/a/api' })).toEqual({ v: 1, name: 'api', seenAt: 5 })
  for (const raw of [
    undefined,
    null,
    'api',
    42,
    [],
    { v: 2, name: 'api', seenAt: 5 },
    { name: 'api', seenAt: 5 },
    { v: 1, seenAt: 5 },
    { v: 1, name: '', seenAt: 5 },
    { v: 1, name: 7, seenAt: 5 },
    { v: 1, name: 'api' },
    { v: 1, name: 'api', seenAt: '5' },
    { v: 1, name: 'api', seenAt: Number.NaN },
  ]) {
    expect(liveEntryOf(raw)).toBeUndefined()
  }
})

test('peers: every other live record; one not touched for more than a day is stale', () => {
  const now = 10 * LIVE_TTL_MS
  const { peers, stale } = peersOf(
    [
      { key: `live/${ID_B}`, value: { v: 1, name: 'api', seenAt: now - LIVE_TTL_MS } },
      { key: 'live/gone', value: { v: 1, name: 'api', seenAt: now - LIVE_TTL_MS - 1 } },
      { key: 'live/broken', value: { v: 1, name: '', seenAt: now } },
      { key: 'other', value: { v: 1, name: 'api', seenAt: now } },
    ],
    now,
  )

  expect(peers).toEqual([{ id: ID_B, name: 'api' }])
  expect(stale).toEqual(['live/gone'])
})

test('the label is asked once, right before the notification posts, and the reminder keeps it', async () => {
  const notifier = createNotifier()
  // A second lookup would see a twin that started meanwhile. The reminder must not make one.
  const answers = ['api', 'api · 3f2a']
  const { host, ran, fire, lookups } = fakeHost(mac(1, SAFARI), undefined, async () => answers.shift())
  await notifier.notification(host, 'permission_prompt')
  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(PERMISSION_BODY, 'api')])
  expect(ran[3]?.[2]).toBe('display notification "Waiting on a permission" with title "Claude needs you · api"')
  expect(lookups.count).toBe(1)

  await fire()
  expect(ran.slice(4)).toEqual([IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(reminderBody(3), 'api')])
  expect(lookups.count).toBe(1)
})

test('no label lookup when nothing posts: at the terminal, off macOS, a type left alone, or a silent turn end', async () => {
  const here = fakeHost(mac(1, ITERM), undefined, async () => 'api')
  await createNotifier().notification(here.host, 'permission_prompt')
  const linux = fakeHost(mac(1, SAFARI, 'Linux'), '{ "notify_on_stop": true }', async () => 'api')
  const off = createNotifier()
  await off.notification(linux.host, 'permission_prompt')
  await off.turnEnded(linux.host)
  const idle = fakeHost(mac(1, SAFARI), undefined, async () => 'api')
  await createNotifier().notification(idle.host, 'idle_prompt')
  await createNotifier().turnEnded(idle.host)

  expect([here.lookups.count, linux.lookups.count, idle.lookups.count]).toEqual([0, 0, 0])
})

test('a label lookup that fails still notifies, under the plain title', async () => {
  const notifier = createNotifier()
  const { host, ran, fire } = fakeHost(mac(1, SAFARI), undefined, async () => {
    throw new Error('the store is gone')
  })
  await notifier.notification(host, 'permission_prompt')
  expect(ran.at(-1)).toEqual(notifyArgv(PERMISSION_BODY))

  await fire()
  expect(ran.at(-1)).toEqual(notifyArgv(reminderBody(3)))
})

test('an answer that lands while the label is looked up: no notification and no reminder', async () => {
  const notifier = createNotifier()
  const { host, ran, timers } = fakeHost(mac(1, SAFARI), undefined, async () => {
    notifier.clear()

    return 'api'
  })
  await notifier.notification(host, 'permission_prompt')

  expect(ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV])
  expect(timers).toEqual([])
})

test('turnEnded title: the stop notification carries the label too', async () => {
  const away = fakeHost(mac(1, SAFARI), '{ "notify_on_stop": true }', async () => 'api · 3f2a')
  await createNotifier().turnEnded(away.host)

  expect(away.ran).toEqual([['uname'], IOREG_ARGV, FRONTMOST_ARGV, notifyArgv(STOP_BODY, 'api · 3f2a')])
  expect(away.ran[3]?.[2]).toBe('display notification "Finished · your turn" with title "Claude needs you · api · 3f2a"')
  expect(away.lookups.count).toBe(1)
})

test("two sessions, two notifiers: clearing one leaves the other's reminder", async () => {
  const left = createNotifier()
  const right = createNotifier()
  const a = fakeHost(mac(1, SAFARI), undefined, async () => 'api · 3f2a')
  const b = fakeHost(mac(1, SAFARI), undefined, async () => 'api · 9b1c')
  await left.notification(a.host, 'permission_prompt')
  await right.notification(b.host, 'permission_prompt')

  // Your prompt in the right-hand session.
  right.clear()
  await a.fire()
  await b.fire()
  expect(a.ran.at(-1)).toEqual(notifyArgv(reminderBody(3), 'api · 3f2a'))
  expect(b.ran).toHaveLength(4)
})
