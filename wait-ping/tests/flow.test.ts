import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { notificationTypeOf, notifyArgv, PERMISSION_BODY, stopBody } from '../hooks/ping'

/**
 * The whole loop through the engine: a turn ending, and a Notification event,
 * each answered by the test's `process.run` so nothing here is spawned for real.
 */

type Settings = { refuse?: string; set: { key: string; value: unknown }[] }

const finish = (turnId: string, durationMs: number, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({
    turnId,
    answer: 'done',
    durationMs,
    isAborted: extra.isAborted === true,
    reason: extra.isAborted ? 'abort' : 'answer',
    ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {}),
  }) as const

const ranValue = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const engineBottom = (on: On, settings: Settings = { set: [] }, opts: { fail?: boolean; uname?: string } = {}) => {
  const ran: string[][] = []
  const uname = opts.uname ?? 'Linux'
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', ($, e) => e)
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'uname') {
      if (e.argv.length !== 1) throw new Error(`uname takes no arguments: ${e.argv.join(' ')}`)

      return ranValue(`${uname}\n`)
    }
    if (e.argv[0] !== 'osascript' && e.argv[0] !== 'notify-send') {
      throw new Error(`not a local notification command: ${e.argv.join(' ')}`)
    }
    if (opts.fail) throw new Error('notify failed')

    return ranValue('')
  })
  on('config.list', () => ({
    value: [
      {
        key: 'wait-ping.enabled',
        label: 'Notify when a turn ends or needs permission',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'wait-ping', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    if (settings.refuse !== undefined) return { deny: settings.refuse }
    settings.set.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return { ran, settings }
}

/** `uname`, then the notification command for the desktop the mock reported. */
const expectArgv = (ran: string[][], body: string, sound: boolean, platform: 'darwin' | 'linux' = 'linux') => {
  expect(ran[0]).toEqual(['uname'])
  expect(ran[1]).toEqual(notifyArgv(platform, body, sound))
  expect(ran).toHaveLength(2)
}

test('a turn under 30 seconds fires nothing', async ($, on) => {
  const { ran } = engineBottom(on)
  const done = await $.turn.complete(finish('turn-short', 29_999))

  expect(done.text).toBe('done')
  expect(ran).toEqual([])
})

test('a turn of 30 seconds notifies, and the command is the local one for this desktop', async ($, on) => {
  const { ran } = engineBottom(on)
  await $.turn.complete(finish('turn-long', 30_000))

  expectArgv(ran, stopBody(30_000), false)
  expect(ran[1]?.[0]).toBe('notify-send')
  expect(ran[1]?.join('\n')).not.toMatch(/sound name|hint=|https?:|curl|wget/)
})

test(
  'one millisecond under a custom threshold is silent, and the threshold itself notifies',
  { options: { thresholdSeconds: 10 } },
  async ($, on) => {
    const { ran } = engineBottom(on)
    await $.turn.complete(finish('turn-under', 9_999))
    expect(ran).toEqual([])

    await $.turn.complete(finish('turn-at', 10_000))
    expectArgv(ran, stopBody(10_000), false)
  },
)

test('interrupting a long turn, or a subagent finishing one, stays silent', async ($, on) => {
  const { ran } = engineBottom(on)
  await $.turn.complete(finish('turn-abort', 120_000, { isAborted: true }))
  await $.turn.complete(finish('turn-sub', 120_000, { agentId: 'agent-1' }))

  expect(ran).toEqual([])
})

test(
  'disabled: a long turn and a permission confirm both stay silent',
  { options: { enabled: false, sound: true } },
  async ($, on) => {
    const { ran } = engineBottom(on)
    await $.turn.complete(finish('turn-off', 120_000))
    await $.classic.Notification({ notification_type: 'permission_prompt' })

    expect(ran).toEqual([])
  },
)

test('a permission confirm notifies even though the turn was short, and idle does not', async ($, on) => {
  const { ran } = engineBottom(on)
  await $.turn.complete(finish('turn-short', 2_000))
  expect(ran).toEqual([])

  await $.classic.Notification({ notification_type: 'idle_prompt' })
  await $.classic.Notification({ notification_type: 'auth_success' })
  expect(ran).toEqual([])

  const event = await $.classic.Notification({ notification_type: 'permission_prompt', message: 'needs you' })
  expect(notificationTypeOf(event)).toBe('permission_prompt')
  expectArgv(ran, PERMISSION_BODY, false)
})

test('sound stays out of the command unless it is turned on', { options: { sound: true } }, async ($, on) => {
  const { ran } = engineBottom(on)
  await $.turn.complete(finish('turn-sound', 45_000))

  expectArgv(ran, stopBody(45_000), true)
  const joined = ran[1]?.join('\n') ?? ''
  expect(joined.includes('sound name "Ping"') || joined.includes('sound-name:message-new-instant')).toBe(true)
})

test('a notification binary that fails does not fail the turn', async ($, on) => {
  const { ran } = engineBottom(on, { set: [] }, { fail: true })
  const done = await $.turn.complete(finish('turn-fail', 60_000))

  expect(done.text).toBe('done')
  expect(ran[0]).toEqual(['uname'])
  expect(ran[1]?.[0]).toBe('notify-send')
  expect(ran).toHaveLength(2)
})

test('/wait-ping turns notifications off, and a long turn is quiet after', async ($, on) => {
  const settings: Settings = { set: [] }
  const { ran } = engineBottom(on, settings)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const reply = await $.command.run({ command: 'wait-ping' } as never)

  expect(reply.text).toMatch(/^off · /)
  expect(reply.text).toContain('/wait-ping turns it on')
  expect(settings.set).toEqual([{ key: 'wait-ping.enabled', value: false }])

  await $.turn.complete(finish('turn-after-off', 120_000))
  expect(ran).toEqual([])
})

test('/wait-ping turns them back on, and says the threshold and that sound is off', async ($, on) => {
  const settings: Settings = { set: [] }
  const { ran } = engineBottom(on, settings)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  await $.command.run({ command: 'wait-ping' } as never)
  const reply = await $.command.run({ command: 'wait-ping' } as never)

  expect(reply.text).toMatch(/^on · /)
  expect(reply.text).toContain('30s')
  expect(reply.text).toContain('sound off')
  expect(reply.text).toContain('/wait-ping again turns it off')
  expect(settings.set.map(row => row.value)).toEqual([false, true])

  await $.turn.complete(finish('turn-after-on', 30_000))
  expectArgv(ran, stopBody(30_000), false)
})

test('Darwin is osascript', async ($, on) => {
  const { ran } = engineBottom(on, { set: [] }, { uname: 'Darwin' })
  await $.turn.complete(finish('turn-mac', 30_000))

  expectArgv(ran, stopBody(30_000), false, 'darwin')
  expect(ran[1]?.join('\n')).not.toContain('sound name')
})

test('an unknown uname sends nothing', async ($, on) => {
  const { ran } = engineBottom(on, { set: [] }, { uname: 'FreeBSD' })
  await $.turn.complete(finish('turn-bsd', 120_000))

  expect(ran).toEqual([['uname']])
})

test('a toggle the settings refuse changes nothing, and says so', async ($, on) => {
  const settings: Settings = { refuse: 'a managed setting owns it', set: [] }
  const { ran } = engineBottom(on, settings)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const reply = await $.command.run({ command: 'wait-ping' } as never)

  expect(reply.text).toMatch(/^still on · /)
  expect(reply.text).toContain('a managed setting owns it')
  await $.turn.complete(finish('turn-still', 30_000))
  expectArgv(ran, stopBody(30_000), false)
})
