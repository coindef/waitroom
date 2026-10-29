import { expect, test } from 'claude-code/testing'

import {
  appleString,
  DEFAULT_THRESHOLD_SECONDS,
  enabledRowKey,
  formatDuration,
  isPermissionNotification,
  LINUX_SOUND,
  MAC_SOUND,
  notificationTypeOf,
  NOTIFY_TITLE,
  PERMISSION_BODY,
  pingPlan,
  platformOfUname,
  shouldPing,
  stopBody,
  thresholdSecondsOf,
  toggledOffLine,
  toggledOnLine,
  toggleRefusedLine,
  wholePositive,
} from '../hooks/ping'

const gate = {
  enabled: true,
  reason: 'stop' as const,
  durationMs: 30_000,
  thresholdSeconds: DEFAULT_THRESHOLD_SECONDS,
}

test('a stop notifies at the threshold and not one millisecond under it', () => {
  expect(shouldPing({ ...gate, durationMs: 29_999 })).toBe(false)
  expect(shouldPing({ ...gate, durationMs: 30_000 })).toBe(true)
  expect(shouldPing({ ...gate, durationMs: 45_000 })).toBe(true)
})

test('a custom threshold is the boundary, not the default', () => {
  expect(shouldPing({ ...gate, thresholdSeconds: 10, durationMs: 9_999 })).toBe(false)
  expect(shouldPing({ ...gate, thresholdSeconds: 10, durationMs: 10_000 })).toBe(true)
})

test('a permission confirm notifies even when the turn is still short', () => {
  expect(shouldPing({ ...gate, reason: 'permission', durationMs: 0 })).toBe(true)
  expect(shouldPing({ ...gate, reason: 'permission', durationMs: 1_000 })).toBe(true)
})

test('disabled stays silent for a long turn and for a permission confirm', () => {
  expect(shouldPing({ ...gate, enabled: false, durationMs: 120_000 })).toBe(false)
  expect(shouldPing({ ...gate, enabled: false, reason: 'permission', durationMs: 0 })).toBe(false)
})

test('a turn the user interrupted, or a subagent turn, does not notify when it ends', () => {
  expect(shouldPing({ ...gate, durationMs: 120_000, aborted: true })).toBe(false)
  expect(shouldPing({ ...gate, durationMs: 120_000, subagent: true })).toBe(false)
})

test('a stop with no usable duration does not notify', () => {
  expect(shouldPing({ ...gate, durationMs: Number.NaN })).toBe(false)
  expect(shouldPing({ ...gate, durationMs: Number.POSITIVE_INFINITY })).toBe(false)
})

test('only the permission_prompt notification type is a permission wait', () => {
  expect(isPermissionNotification('permission_prompt')).toBe(true)
  expect(isPermissionNotification('idle_prompt')).toBe(false)
  expect(isPermissionNotification('auth_success')).toBe(false)
  expect(isPermissionNotification(undefined)).toBe(false)
  expect(notificationTypeOf({ notification_type: 'permission_prompt' })).toBe('permission_prompt')
  expect(notificationTypeOf({})).toBeUndefined()
})

test('the stop line is the turn wall-clock, under a minute, an exact minute, or both', () => {
  expect(formatDuration(0)).toBe('0s')
  expect(formatDuration(45_000)).toBe('45s')
  expect(formatDuration(59_999)).toBe('59s')
  expect(formatDuration(60_000)).toBe('1m')
  expect(formatDuration(90_000)).toBe('1m 30s')
  expect(stopBody(45_000)).toBe('You were away 45s')
  expect(stopBody(60_000)).toBe('You were away 1m')
  expect(stopBody(90_000)).toBe('You were away 1m 30s')
  expect(PERMISSION_BODY).toBe('Needs your OK')
  expect(NOTIFY_TITLE).toBe('Waitroom')
})

test('an unusable threshold falls back to 30 seconds', () => {
  expect(wholePositive(30, 999)).toBe(30)
  expect(wholePositive(12.9, 999)).toBe(12)
  expect(wholePositive(0, 999)).toBe(999)
  expect(wholePositive(-5, 999)).toBe(999)
  expect(wholePositive('nope', 999)).toBe(999)
  expect(thresholdSecondsOf(undefined)).toBe(30)
  expect(thresholdSecondsOf(0)).toBe(30)
  expect(thresholdSecondsOf(45)).toBe(45)
})

test('darwin is silent unless sound is on, and the command is osascript alone', () => {
  const silent = pingPlan({ ...gate, sound: false, platform: 'darwin' })

  expect(silent).toEqual([
    'osascript',
    '-e',
    'display notification "You were away 30s" with title "Waitroom"',
  ])
  expect(silent?.join('\n')).not.toContain('sound name')
  expect(silent?.join('\n')).not.toContain(MAC_SOUND)

  expect(pingPlan({ ...gate, sound: true, platform: 'darwin' })).toEqual([
    'osascript',
    '-e',
    'display notification "You were away 30s" with title "Waitroom" sound name "Ping"',
  ])
})

test('linux is silent unless sound is on, and the command is notify-send alone', () => {
  const silent = pingPlan({ ...gate, sound: false, platform: 'linux' })

  expect(silent).toEqual(['notify-send', 'Waitroom', 'You were away 30s'])
  expect(silent?.join('\n')).not.toContain('hint')
  expect(silent?.join('\n')).not.toContain(LINUX_SOUND)

  expect(pingPlan({ ...gate, sound: true, platform: 'linux', reason: 'permission', durationMs: 0 })).toEqual([
    'notify-send',
    `--hint=string:sound-name:${LINUX_SOUND}`,
    NOTIFY_TITLE,
    PERMISSION_BODY,
  ])
})

test('uname Darwin and Linux are the only desktops, and anything else builds no command', () => {
  expect(platformOfUname('Darwin\n')).toBe('darwin')
  expect(platformOfUname('Linux\n')).toBe('linux')
  expect(platformOfUname('MINGW64_NT-10.0\n')).toBe('other')
  expect(platformOfUname('')).toBe('other')
  expect(pingPlan({ ...gate, sound: true, platform: 'other' })).toBeNull()
})

test('a short turn and a non-permission notification build no command', () => {
  expect(pingPlan({ ...gate, sound: false, platform: 'linux', durationMs: 29_999 })).toBeNull()
  expect(pingPlan({ ...gate, sound: true, platform: 'darwin', enabled: false })).toBeNull()
})

test('quotes and shell metacharacters stay inside one osascript argument', () => {
  expect(appleString('say "hi" \\ now')).toBe('"say \\"hi\\" \\\\ now"')
  const argv = pingPlan({
    ...gate,
    sound: false,
    platform: 'darwin',
    reason: 'permission',
    durationMs: 0,
  })
  // The permission body has no metacharacters; a hostile body would still be one argument.
  expect(argv?.[0]).toBe('osascript')
  expect(argv).toHaveLength(3)
  expect(argv?.[2]).toContain(`"${PERMISSION_BODY}"`)
  expect(argv?.some(part => part === 'sh' || part === 'bash' || part.includes('http'))).toBe(false)
})

test('the on line names the threshold and that sound is off unless it is on', () => {
  const on = toggledOnLine(30, false)
  expect(on).toMatch(/^on · /)
  expect(on).toContain('30s')
  expect(on).toContain('sound off')
  expect(on).toContain('/wait-ping again turns it off')
  expect(toggledOnLine(45, true)).toContain('sound on')

  const off = toggledOffLine()
  expect(off).toBe('off · /wait-ping turns it on')
  expect(off).not.toContain('30s')
})

test('a refused toggle says nothing moved, why, and where else the setting lives', () => {
  const line = toggleRefusedLine(true, 'a managed setting owns it')
  expect(line).toMatch(/^still on · /)
  expect(line).toContain('a managed setting owns it')
  expect(line).toContain('/plugin → wait-ping → Notify when a turn ends or needs permission')
  expect(toggleRefusedLine(false, 'x')).toMatch(/^still off · /)
})

test('no line names the plugin again: the engine already prints wait-ping: in front of it', () => {
  for (const line of [toggledOnLine(30, false), toggledOffLine(), toggleRefusedLine(true, 'locked')]) {
    expect(line).not.toMatch(/^wait-ping\b/)
  }
})

test("the enabled row is found under the installed name or a working copy's, and nothing else", () => {
  expect(enabledRowKey([{ key: 'theme' }, { key: 'wait-ping.enabled' }])).toBe('wait-ping.enabled')
  expect(enabledRowKey([{ key: 'wait-ping@inline.enabled' }])).toBe('wait-ping@inline.enabled')
  expect(enabledRowKey([{ key: 'wait-ping.sound' }, { key: 'wait-ping-x.enabled' }])).toBe('wait-ping.enabled')
  expect(enabledRowKey([])).toBe('wait-ping.enabled')
})
