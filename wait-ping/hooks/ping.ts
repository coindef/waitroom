/**
 * Pure ping logic: no engine, no $, so `claude plugin test` exercises it
 * directly. The only commands it builds are the local notification binaries
 * below. It never builds a shell command and never names a network client.
 */

/** How long a turn runs before a stop notification. A permission confirm does not wait for this. */
export const DEFAULT_THRESHOLD_SECONDS = 30

/** The notification's title. Locked copy. */
export const NOTIFY_TITLE = 'Waitroom'

/** A permission confirm that has been waiting. Claude Code's own Notification type. */
export const PERMISSION_NOTIFICATION = 'permission_prompt'

/** Locked copy for a permission confirm that has been waiting. */
export const PERMISSION_BODY = 'Needs your OK'

/**
 * Built-in macOS sound, played only when sound is on.
 * `display notification` without `sound name` is silent.
 */
export const MAC_SOUND = 'Ping'

/**
 * Freedesktop sound name, passed as a notify-send hint only when sound is on.
 * Without the hint, notify-send does not ask for a sound.
 */
export const LINUX_SOUND = 'message-new-instant'

export type PingReason = 'stop' | 'permission'

export type Platform = 'darwin' | 'linux' | 'other'

/** A positive whole number from config, or `fallback` for anything else. */
export const wholePositive = (value: unknown, fallback: number): number => {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** The stop threshold, in seconds. Anything unusable stays at the default, so a bad value cannot notify every turn. */
export const thresholdSecondsOf = (value: unknown): number => wholePositive(value, DEFAULT_THRESHOLD_SECONDS)

/**
 * `uname`'s first line, and nothing else.
 *
 * The hooks module has no `process` global to read a platform from, so the
 * desktop is this local command's answer: `Darwin` or `Linux`.
 */
export const platformOfUname = (stdout: string): Platform => {
  const name = stdout.trim()
  if (name === 'Darwin') return 'darwin'
  if (name === 'Linux') return 'linux'

  return 'other'
}

/** Whether a Notification event is a permission confirm that has been waiting. Anything else is not. */
export const isPermissionNotification = (notificationType: unknown): boolean =>
  notificationType === PERMISSION_NOTIFICATION

/**
 * The `notification_type` field off a classic Notification event.
 *
 * The field is the settings-hook name (`notification_type`), which is what
 * `classic.Notification` delivers. A missing field is not a permission wait.
 */
export const notificationTypeOf = (event: object): unknown => {
  if (!('notification_type' in event)) return undefined

  return event.notification_type
}

export type PingInput = {
  enabled: boolean
  reason: PingReason
  /** How long the turn ran, in milliseconds. Ignored for a permission confirm. */
  durationMs: number
  thresholdSeconds: number
  /** The user interrupted the turn. They are at the keyboard. */
  aborted?: boolean
  /** A subagent's turn. The handoff is the main turn. */
  subagent?: boolean
}

/**
 * Whether this moment may notify.
 *
 * A stop notifies only once the turn has run at least the threshold.
 * A permission confirm notifies even when the turn is still short: that wait
 * is the other half of the gate. Off means neither.
 */
export const shouldPing = (input: PingInput): boolean => {
  if (!input.enabled) return false
  if (input.reason === 'permission') return true
  if (input.aborted || input.subagent) return false
  if (!Number.isFinite(input.durationMs)) return false

  return input.durationMs >= input.thresholdSeconds * 1000
}

/** `45s`, `1m`, `1m 30s`. Whole seconds, rounded down. */
export const formatDuration = (durationMs: number): string => {
  const total = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  if (seconds === 0) return `${minutes}m`

  return `${minutes}m ${seconds}s`
}

/**
 * Locked copy for a turn that ended.
 *
 * "Away" here is the turn's own wall-clock (`durationMs`), not a separate
 * tracker and not a network call. Under a minute it is `45s`. An exact
 * minute is `1m`. Anything between is `1m 30s`.
 */
export const stopBody = (durationMs: number): string => `You were away ${formatDuration(durationMs)}`

/** One AppleScript string literal. Quotes and backslashes stay inside it. */
export const appleString = (text: string): string =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`

/**
 * The argv for one local notification, or null where this machine has no path.
 *
 * `sound` adds the desktop's own sound request. It never adds a second
 * program, and it adds nothing when sound is off.
 */
export const notifyArgv = (platform: Platform, body: string, sound: boolean): readonly string[] | null => {
  if (platform === 'darwin') {
    const soundClause = sound ? ` sound name ${appleString(MAC_SOUND)}` : ''

    return [
      'osascript',
      '-e',
      `display notification ${appleString(body)} with title ${appleString(NOTIFY_TITLE)}${soundClause}`,
    ]
  }
  if (platform === 'linux') {
    return sound
      ? ['notify-send', `--hint=string:sound-name:${LINUX_SOUND}`, NOTIFY_TITLE, body]
      : ['notify-send', NOTIFY_TITLE, body]
  }

  return null
}

export type PlanInput = PingInput & { sound: boolean; platform: Platform }

/** The argv to run for this moment, or null when the gate says no or this desktop has no path. */
export const pingPlan = (input: PlanInput): readonly string[] | null => {
  if (!shouldPing(input)) return null
  const body = input.reason === 'permission' ? PERMISSION_BODY : stopBody(input.durationMs)

  return notifyArgv(input.platform, body, input.sound)
}

/**
 * The `/config` row this plugin's `enabled` field answers to: a row's key is
 * `<plugin>.<field>`, and a working copy loaded with `--plugin-dir` may carry
 * a suffix on its name (`wait-ping@inline`).
 */
export const ENABLED_ROW = /^wait-ping(@[\w-]+)?\.enabled$/

/** The key `$.config.set` takes for `enabled`, read off the rows `$.config.list()` returns. */
export const enabledRowKey = (rows: readonly { key: string }[]): string =>
  rows.find(row => ENABLED_ROW.test(row.key))?.key ?? 'wait-ping.enabled'

/**
 * What `/wait-ping` answers once it has turned notifications on.
 *
 * The engine prints it as `wait-ping: on · …`, so the line does not name the
 * plugin again. Sound is reported, not flipped: that switch is its own setting.
 */
export const toggledOnLine = (thresholdSeconds: number, sound: boolean): string =>
  `on · a local notification once a turn runs ${thresholdSeconds}s, or when a permission confirm is waiting · ` +
  `sound ${sound ? 'on' : 'off'} · /wait-ping again turns it off`

/** What `/wait-ping` answers once notifications are off. */
export const toggledOffLine = (): string => 'off · /wait-ping turns it on'

/** What `/wait-ping` answers when the setting could not be changed: nothing moved, and where else it lives. */
export const toggleRefusedLine = (enabled: boolean, reason: string): string =>
  `still ${enabled ? 'on' : 'off'} · the setting did not change (${reason}) · ` +
  '/plugin → wait-ping → Notify when a turn ends or needs permission'
