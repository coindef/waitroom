/**
 * wait-notify's logic: no engine and no `$`, so `claude plugin test`
 * exercises it directly.
 *
 * The functions read what `uname`, `ioreg` and `osascript` print and build the
 * argv to run. They never build a shell command and never name a network
 * client. `createNotifier` holds the one wait being watched and decides when
 * those commands run. Every command, the reminder's timer, the config file and
 * the session's label reach it through a host the hooks module builds from
 * `$`; a test hands it its own.
 */

/** The notification's title, before the session's label. Locked copy. */
export const NOTIFY_TITLE = 'Claude needs you'

/** Locked copy: a permission dialog is waiting on you. */
export const PERMISSION_BODY = 'Waiting on a permission'

/** Locked copy: Claude asked you something and is waiting on the answer. */
export const QUESTION_BODY = 'Asked you a question'

/** Locked copy for the one reminder, with the minutes from the config: `Still waiting · 3 min`. */
export const reminderBody = (minutes: number): string => `Still waiting · ${minutes} min`

/** A main-loop turn that ended. Sent only when `notify_on_stop` is on. */
export const STOP_BODY = 'Finished · your turn'

/** `~/.waitroom/notify.json` as read: each key's own value, or its default. */
export type NotifyConfig = {
  /** Under this many seconds since your last key or mouse event, with a terminal in front, you are at the terminal. */
  presentIdleSecs: number
  /** Minutes from the notification to the one reminder. */
  remindAfterMin: number
  /** A turn that ends notifies too. Off by default: a normal turn end is silent. */
  notifyOnStop: boolean
}

export const DEFAULT_CONFIG: Readonly<NotifyConfig> = Object.freeze({
  presentIdleSecs: 30,
  remindAfterMin: 3,
  notifyOnStop: false,
})

/** The config file, under the home folder. */
export const CONFIG_FILE = '.waitroom/notify.json'

/** `$HOME/.waitroom/notify.json`. A hooks module has no `~` to expand, so the home folder comes from `HOME`. */
export const configPathOf = (home: string): string => `${home.replace(/\/+$/, '')}/${CONFIG_FILE}`

/** A day. Past it, `present_idle_secs` is a typo rather than a threshold. */
export const MAX_PRESENT_IDLE_SECS = 24 * 60 * 60

/** A day. Past it, `remind_after_min` is a typo, and not a timer this mod sets. */
export const MAX_REMIND_AFTER_MIN = 24 * 60

/** A number above 0 and at most `max`, or `fallback` for anything else (a string, `null`, `0`, `-1`). */
const within = (value: unknown, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : fallback

/**
 * The config from the file's text.
 *
 * No file, or text that is not a JSON object: every default. A key that is
 * missing, of the wrong type or out of range: that key's default. Keys it
 * does not know are ignored. Only `true` turns `notify_on_stop` on.
 */
export const configOf = (text: string | undefined): NotifyConfig => {
  const defaults = { ...DEFAULT_CONFIG }
  if (text === undefined) return defaults
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return defaults
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults
  const file = parsed as Record<string, unknown>

  return {
    presentIdleSecs: within(file.present_idle_secs, MAX_PRESENT_IDLE_SECS, DEFAULT_CONFIG.presentIdleSecs),
    remindAfterMin: within(file.remind_after_min, MAX_REMIND_AFTER_MIN, DEFAULT_CONFIG.remindAfterMin),
    notifyOnStop: file.notify_on_stop === true,
  }
}

/** `uname`'s answer, as far as this mod cares: macOS, or not. */
export type Platform = 'darwin' | 'other'

/** `uname` with no arguments prints `Darwin` on macOS. Anything else is not macOS. */
export const platformOfUname = (stdout: string): Platform => (stdout.trim() === 'Darwin' ? 'darwin' : 'other')

/** No arguments: the kernel's name. The hooks module has no `process` global to read a platform from. */
export const UNAME_ARGV: readonly string[] = ['uname']

/** The HID system's registry entry. Its `HIDIdleTime` is the time since your last key or mouse event. */
export const IOREG_ARGV: readonly string[] = ['ioreg', '-c', 'IOHIDSystem']

/**
 * The frontmost app's bundle path, `/Applications/iTerm.app/`.
 *
 * `path to frontmost application` is a Standard Additions command. It does
 * not go through System Events, which asks for Automation permission the
 * first time a terminal uses it.
 */
export const FRONTMOST_SCRIPT = 'POSIX path of (path to frontmost application)'

export const FRONTMOST_ARGV: readonly string[] = ['osascript', '-e', FRONTMOST_SCRIPT]

/**
 * Seconds since your last key or mouse event: the first `"HIDIdleTime" =
 * <nanoseconds>` line `ioreg -c IOHIDSystem` prints. Undefined when there is none.
 */
export const idleSecondsOf = (stdout: string): number | undefined => {
  const nanoseconds = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)?.[1]

  return nanoseconds === undefined ? undefined : Number(nanoseconds) / 1e9
}

/**
 * The frontmost app's name from what the check printed: the bundle's name off
 * its path (`/Applications/iTerm.app/` is `iTerm`), or the line itself when it
 * is already a bare name.
 */
export const frontmostAppOf = (stdout: string): string => {
  const path = stdout.trim().replace(/\/+$/, '')

  return path.slice(path.lastIndexOf('/') + 1).replace(/\.app$/i, '')
}

/**
 * The apps that count as the terminal: Terminal, iTerm2, Ghostty, VS Code and
 * Cursor. Each by its bundle's name, which is what the frontmost check prints
 * (`iTerm`, `Visual Studio Code`), and by the process name System Events
 * reports for the same app (`iTerm2`, `Code`, `Electron`). Matched without case.
 */
export const TERMINAL_APPS: readonly string[] = [
  'Terminal',
  'iTerm',
  'iTerm2',
  'Ghostty',
  'Visual Studio Code',
  'Visual Studio Code - Insiders',
  'Code',
  'Code - Insiders',
  'Electron',
  'Cursor',
]

const TERMINAL_APP_KEYS = new Set(TERMINAL_APPS.map(name => name.toLowerCase()))

export const isTerminalApp = (name: string): boolean => TERMINAL_APP_KEYS.has(name.trim().toLowerCase())

/** At the terminal: idle under the threshold, and a terminal in front. An idle time or app nobody could read is away. */
export const isPresent = (idleSeconds: number | undefined, app: string | undefined, presentIdleSecs: number): boolean =>
  idleSeconds !== undefined && idleSeconds < presentIdleSecs && app !== undefined && isTerminalApp(app)

/**
 * The idle threshold at the reminder's recheck: the whole wait, or
 * `present_idle_secs` when that is longer.
 *
 * Claude Code raises no event when you answer a permission dialog. PreToolUse
 * runs before the dialog opens, and the call's end can come long after your
 * answer. But the answer is a key or a click at the terminal, so a key or
 * mouse event since the notification, with a terminal in front now, means you
 * came back.
 */
export const recheckIdleSecs = (config: NotifyConfig): number =>
  Math.max(config.presentIdleSecs, config.remindAfterMin * 60)

/** What Claude is blocked on. */
export type WaitKind = 'permission' | 'question'

/** A permission dialog that has waited without input. The dialog AskUserQuestion opens sends it too. */
export const PERMISSION_NOTIFICATION = 'permission_prompt'

/** An MCP server's question (an elicitation form) that Claude is blocked on. */
export const QUESTION_NOTIFICATION = 'elicitation_dialog'

/** The tool Claude asks you a question with. Claude Code sends `permission_prompt` for its dialog. */
export const QUESTION_TOOL = 'AskUserQuestion'

/**
 * Which wait a Notification event is, or null for one this mod leaves alone.
 *
 * `permission_prompt` is a permission, unless an AskUserQuestion call is open:
 * then it is that question's dialog. `elicitation_dialog` is a question. Every
 * other type is null, `idle_prompt` included: Claude Code sends that once a
 * finished turn has sat idle, and a turn end stays silent here.
 */
export const waitKindOf = (notificationType: unknown, isAsking: boolean): WaitKind | null => {
  if (notificationType === PERMISSION_NOTIFICATION) return isAsking ? 'question' : 'permission'
  if (notificationType === QUESTION_NOTIFICATION) return 'question'

  return null
}

export const bodyOf = (kind: WaitKind): string => (kind === 'question' ? QUESTION_BODY : PERMISSION_BODY)

/** The `notification_type` field off a classic Notification event, named as its settings hook names it. */
export const notificationTypeOf = (event: object): unknown =>
  'notification_type' in event ? event.notification_type : undefined

/** A prompt you sent: typed at the prompt (`composer`), or from your phone or the web (`bridge`). */
export const isPersonPrompt = (origin: { readonly kind: string } | undefined): boolean =>
  origin?.kind === 'composer' || origin?.kind === 'bridge'

/** One AppleScript string literal. Quotes and backslashes stay inside it. */
export const appleString = (text: string): string =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`

/** The title: `Claude needs you`, then the session's label when there is one, `Claude needs you · api · 3f2a`. */
export const titleOf = (label: string | undefined): string =>
  label === undefined || label === '' ? NOTIFY_TITLE : `${NOTIFY_TITLE} · ${label}`

/**
 * The argv for one native notification. `display notification` without `sound
 * name` is silent. With no label, the title is the plain `Claude needs you`.
 */
export const notifyArgv = (body: string, label?: string): readonly string[] => [
  'osascript',
  '-e',
  `display notification ${appleString(body)} with title ${appleString(titleOf(label))}`,
]

/** The most graphemes of a folder's name a title shows, the parent folder's too. One more becomes `…`. */
export const MAX_FOLDER_GRAPHEMES = 20

const ELLIPSIS = '…'

type SegmenterCtor = new (
  locales?: string,
  options?: { granularity: 'grapheme' },
) => { segment: (input: string) => Iterable<{ segment: string }> }

/** User-perceived characters: Intl.Segmenter where the host has it, else code points. */
const graphemes = (text: string): string[] => {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
  if (Segmenter === undefined) return [...text]

  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.segment)
}

/** CSI, OSC, and a lone ESC-Fe sequence. Stripped before control characters, so a color code leaves no letters behind. */
const ANSI = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

/** C0, DEL, C1, zero-width and byte-order marks, bidi overrides and isolates, line and paragraph separators. Not the emoji joiner. */
const UNSHOWN = /[\u0000-\u001F\u007F-\u009F\u200B\u200C\u200E\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g

/** The root's parts between separators, `/` or `\`, once those that end it are gone: `/x/work/api/` is `['', 'x', 'work', 'api']`. */
const segmentsOf = (root: string): string[] => root.replace(/[\\/]+$/, '').split(/[\\/]+/)

/**
 * One folder's name as a title shows it, or undefined when there is none to
 * show: `.`, `..`, or nothing left once escape codes and control characters
 * are dropped. Past 20 graphemes it is cut on a grapheme boundary and ends in `…`.
 */
const shownNameOf = (segment: string): string | undefined => {
  const name = segment.replace(ANSI, '').replace(UNSHOWN, '').normalize('NFC').trim()
  if (name === '' || name === '.' || name === '..') return undefined
  const parts = graphemes(name)
  if (parts.length <= MAX_FOLDER_GRAPHEMES) return name

  return `${parts.slice(0, MAX_FOLDER_GRAPHEMES - 1).join('').trimEnd()}${ELLIPSIS}`
}

/**
 * The project root's folder name as a title shows it, or undefined when there
 * is none to show: not a string, `/`, `.` or `..`, or nothing left once
 * escape codes and control characters are dropped. Never the path above it.
 * Past 20 graphemes it is cut on a grapheme boundary and ends in `…`.
 */
export const folderNameOf = (root: unknown): string | undefined =>
  typeof root === 'string' ? shownNameOf(segmentsOf(root).at(-1) ?? '') : undefined

/** A drive, `C:`: the root of a Windows path, not a folder with a name. */
const DRIVE = /^[a-z]:$/i

/**
 * The name of the folder the project folder is in, cleaned and cut as the
 * folder name is: `work` for `/Users/ada/work/api`. Undefined when there is
 * none to show: a folder right under the root (`/api`, `C:\api`), a parent
 * that is `.`, `..` or nothing once cleaned, or a root with no folder name.
 * Never the path above it.
 */
export const parentNameOf = (root: unknown): string | undefined => {
  if (typeof root !== 'string' || folderNameOf(root) === undefined) return undefined
  const parent = shownNameOf(segmentsOf(root).at(-2) ?? '')

  return parent === undefined || DRIVE.test(parent) ? undefined : parent
}

/** The session id's letters and digits, lowercased: what a tag is cut from. */
const tagSource = (id: unknown): string => (typeof id === 'string' ? id.replace(/[^0-9a-z]/gi, '').toLowerCase() : '')

const MIN_TAG = 4
const MAX_TAG = 8

/**
 * A short tag from the host's session id: its first 4 letters and digits,
 * longer while a same-name peer's id starts the same way, at most 8.
 */
export const tagOf = (id: string, peerIds: readonly string[]): string => {
  const mine = tagSource(id)
  const theirs = peerIds.map(tagSource)
  for (let length = MIN_TAG; length < MAX_TAG; length += 1) {
    const tag = mine.slice(0, length)
    if (!theirs.some(other => other.startsWith(tag))) return tag
  }

  return mine.slice(0, MAX_TAG)
}

/** Another live session, as its record in the plugin store has it. No `parent`: none to show, or a record an older build wrote. */
export type Peer = { id: string; name: string; parent?: string }

/**
 * The session's label: the folder name alone while no live peer's folder has
 * the same name. With such a twin, the parent folder's name and the folder's,
 * `work/api`, when no twin's parent has the same name. Otherwise, or with no
 * parent to show, the folder name and this session's tag, `api · 3f2a`, cut
 * against every twin. A twin whose parent is unknown never has the same one.
 * Undefined when the host gave no session id or no project root with a folder
 * name: the title is then the plain one.
 */
export const sessionLabel = (self: { id: unknown; root: unknown }, peers: readonly Peer[]): string | undefined => {
  const name = folderNameOf(self.root)
  if (name === undefined || tagSource(self.id) === '' || typeof self.id !== 'string') return undefined
  const id = self.id.trim()
  const twins = peers.filter(peer => peer.name === name && peer.id !== id)
  if (twins.length === 0) return name
  const parent = parentNameOf(self.root)
  if (parent !== undefined && !twins.some(twin => twin.parent === parent)) return `${parent}/${name}`

  return `${name} · ${tagOf(id, twins.map(twin => twin.id))}`
}

/** Where each live session keeps its record in the plugin store, by session id. */
export const LIVE_PREFIX = 'live/'

/** A record not touched for a day is a session that ended without saying so. */
export const LIVE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A live session's record: its folder name and its parent folder's name as
 * titles show them, and when it was last seen. No `parent` when there is none
 * to show. An older build wrote none either, so a record without one is
 * still a record, its parent unknown.
 */
export type LiveEntry = { v: 1; name: string; parent?: string; seenAt: number }

export const liveKeyOf = (id: unknown): string | undefined => {
  const trimmed = typeof id === 'string' ? id.trim() : ''

  return trimmed === '' ? undefined : `${LIVE_PREFIX}${trimmed}`
}

/**
 * A stored value as a record, or undefined for anything else. A `parent` that
 * is missing or not a name counts as unknown, and the record still counts.
 * Fields it does not know are dropped.
 */
export const liveEntryOf = (raw: unknown): LiveEntry | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { v, name, parent, seenAt } = raw as Record<string, unknown>
  if (v !== 1 || typeof name !== 'string' || name === '') return undefined
  if (typeof seenAt !== 'number' || !Number.isFinite(seenAt)) return undefined

  return typeof parent === 'string' && parent !== '' ? { v: 1, name, parent, seenAt } : { v: 1, name, seenAt }
}

/**
 * This session's record and its key, or undefined when the host gave no id or
 * no folder name. `parent` only when there is one to show.
 */
export const liveRecordOf = (
  self: { id: unknown; root: unknown },
  now: number,
): { key: string; entry: LiveEntry } | undefined => {
  const name = folderNameOf(self.root)
  const key = tagSource(self.id) === '' ? undefined : liveKeyOf(self.id)
  if (name === undefined || key === undefined) return undefined
  const parent = parentNameOf(self.root)

  return { key, entry: parent === undefined ? { v: 1, name, seenAt: now } : { v: 1, name, parent, seenAt: now } }
}

/** A record's session as a peer. Its parent comes along only when the record has one. */
const peerOf = (id: string, { name, parent }: LiveEntry): Peer =>
  parent === undefined ? { id, name } : { id, name, parent }

/**
 * The live sessions in the store: every valid record under `live/` seen within
 * a day, and the keys of the stale ones, to remove. The caller drops its own.
 */
export const peersOf = (
  records: readonly { key: string; value: unknown }[],
  now: number,
): { peers: Peer[]; stale: string[] } => {
  const peers: Peer[] = []
  const stale: string[] = []
  for (const { key, value } of records) {
    if (!key.startsWith(LIVE_PREFIX)) continue
    const entry = liveEntryOf(value)
    if (entry === undefined) continue
    if (now - entry.seenAt > LIVE_TTL_MS) stale.push(key)
    else peers.push(peerOf(key.slice(LIVE_PREFIX.length), entry))
  }

  return { peers, stale }
}

/** What a command left that this mod reads. */
export type RunResult = { exitCode: number; stdout: string }

/** The world the notifier acts in, built from `$` by the hooks module. */
export type NotifyHost = {
  /** Runs a command by argv, with no shell. Undefined when it could not start, or ran past `timeoutMs`. */
  run: (argv: readonly string[], timeoutMs: number) => Promise<RunResult | undefined>
  /** Calls `fn` once after `ms`, unless cancelled first. */
  after: (ms: number, fn: () => Promise<void>) => { cancel: () => void }
  /** The config file's text, or undefined when there is none or it cannot be read. */
  readConfig: () => Promise<string | undefined>
  /** This session's label for the title, `api`, `work/api` or `api · 3f2a`; undefined for the plain title. */
  label: () => Promise<string | undefined>
}

/** The label, or undefined when looking it up failed: a notification still goes out, under the plain title. */
const labelOf = (host: NotifyHost): Promise<string | undefined> => host.label().catch(() => undefined)

/** Local commands return quickly. A hang must not hold the event it rides on. */
export const UNAME_TIMEOUT_MS = 2_000
export const PRESENCE_TIMEOUT_MS = 3_000
export const NOTIFY_TIMEOUT_MS = 5_000

/**
 * Whether you are at the terminal now: `ioreg` first, then `osascript` only
 * when the idle time is under the threshold.
 *
 * A command that fails, or prints nothing this can read, counts as away:
 * better a notification you did not need than a wait nobody hears about.
 */
export const checkPresence = async (host: NotifyHost, presentIdleSecs: number): Promise<boolean> => {
  const hid = await host.run(IOREG_ARGV, PRESENCE_TIMEOUT_MS)
  const idleSeconds = hid?.exitCode === 0 ? idleSecondsOf(hid.stdout) : undefined
  if (idleSeconds === undefined || idleSeconds >= presentIdleSecs) return false
  const front = await host.run(FRONTMOST_ARGV, PRESENCE_TIMEOUT_MS)
  if (front?.exitCode !== 0) return false

  return isPresent(idleSeconds, frontmostAppOf(front.stdout), presentIdleSecs)
}

/**
 * The wait being watched: when it began, in the notifier's own order, its
 * reminder once armed, and the label its notification went out under.
 */
type Wait = { since: number; reminder?: { cancel: () => void }; label?: string }

export type Notifier = {
  /** A tool call starts. The stamp it returns goes back to `toolSettled` when the call ends. */
  toolStarted: (tool: string) => number
  /** A tool call ended. One that was already running when the wait began means the wait is over. */
  toolSettled: (stamp: number, tool: string) => void
  /** A Notification event: notify now if you are away, and arm the one reminder. */
  notification: (host: NotifyHost, notificationType: unknown) => Promise<void>
  /** The wait is over: your prompt, the main turn's end, an answered MCP question, the session's end. */
  clear: () => void
  /** A main-loop turn ended without an interrupt: a notification only with `notify_on_stop`. */
  turnEnded: (host: NotifyHost) => Promise<void>
}

/**
 * One wait at a time, from the Notification that starts it to the reminder
 * or whatever clears it first. A newer Notification replaces it.
 */
export const createNotifier = (): Notifier => {
  /** One counter for tool calls and waits, so "already running when the wait began" is a comparison. */
  let order = 0
  /** AskUserQuestion calls in flight. */
  let asking = 0
  /** Whether `uname` said Darwin, once it has answered. A `uname` that failed is asked again next time. */
  let isMac: boolean | undefined
  let wait: Wait | null = null

  const clear = () => {
    wait?.reminder?.cancel()
    wait = null
  }

  const onMac = async (host: NotifyHost): Promise<boolean> => {
    if (isMac !== undefined) return isMac
    const found = await host.run(UNAME_ARGV, UNAME_TIMEOUT_MS)
    if (found?.exitCode !== 0) return false
    isMac = platformOfUname(found.stdout) === 'darwin'

    return isMac
  }

  const remind = async (host: NotifyHost, mine: Wait, config: NotifyConfig): Promise<void> => {
    if (wait !== mine) return
    // Back at the terminal at any point since the notification counts, not only now.
    const isHere = await checkPresence(host, recheckIdleSecs(config))
    if (wait !== mine) return
    // One check, one reminder at most: the wait is done either way.
    wait = null
    if (isHere) return
    // The title the notification had: a session that started since does not change it.
    await host.run(notifyArgv(reminderBody(config.remindAfterMin), mine.label), NOTIFY_TIMEOUT_MS)
  }

  return {
    toolStarted: tool => {
      if (tool === QUESTION_TOOL) asking += 1
      order += 1

      return order
    },

    toolSettled: (stamp, tool) => {
      if (tool === QUESTION_TOOL && asking > 0) asking -= 1
      if (wait !== null && stamp < wait.since) clear()
    },

    notification: async (host, notificationType) => {
      const kind = waitKindOf(notificationType, asking > 0)
      if (kind === null) return
      clear()
      order += 1
      const mine: Wait = { since: order }
      wait = mine
      // Each await below can end with the wait cleared: your answer came in meanwhile.
      const isMine = () => wait === mine
      if (!(await onMac(host))) {
        if (isMine()) wait = null

        return
      }
      const config = configOf(await host.readConfig())
      if (!isMine()) return
      const isHere = await checkPresence(host, config.presentIdleSecs)
      if (!isMine()) return
      if (isHere) {
        // You saw it: nothing now, and no reminder later.
        wait = null

        return
      }
      mine.label = await labelOf(host)
      if (!isMine()) return
      await host.run(notifyArgv(bodyOf(kind), mine.label), NOTIFY_TIMEOUT_MS)
      if (!isMine()) return
      mine.reminder = host.after(config.remindAfterMin * 60_000, () => remind(host, mine, config))
    },

    clear,

    turnEnded: async host => {
      const config = configOf(await host.readConfig())
      if (!config.notifyOnStop) return
      if (!(await onMac(host))) return
      if (await checkPresence(host, config.presentIdleSecs)) return
      await host.run(notifyArgv(STOP_BODY, await labelOf(host)), NOTIFY_TIMEOUT_MS)
    },
  }
}
