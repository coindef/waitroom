/**
 * Pure shell-list logic: no engine, no $, so `claude plugin test` exercises
 * it directly. It reads a Bash call's command and the answer that came back
 * for it, and nothing else. It never runs a command, refuses or rewrites a
 * call, writes a file, or makes a network call.
 */

import type { CommandOutcome, ShellCommand, ShellTurn } from '../types'

/** Glance cap: past this, one line counts the earlier commands instead of another row. */
export const MAX_ROWS = 8

/** The most characters of one command a row keeps: enough to read it, not a whole script. */
export const MAX_COMMAND_CHARS = 200

/** Card copy. The title is the whole title: no tag beside it. */
export const TITLE = 'Shell commands this turn'
export const SUBTITLE = 'Newest last · only a list, nothing blocked or sent'
export const DISMISS_LABEL = 'Close'
export const DISABLE_LABEL = "Don't show again"

/** What a line break inside one command shows as, so each command stays one row. */
export const LINE_BREAK = ' ↵ '

/** The `enabled` field's title: the command lines name it as the way back. */
const ENABLED_TITLE = 'List the shell commands a turn ran'

/** Rows the card spends before the first command: its title and its subtitle. */
const HEADER_ROWS = 2

/** `1 shell command`, `3 shell commands`. */
export const countLine = (count: number): string => `${count} shell command${count === 1 ? '' : 's'}`

/** The status line: the turn's count, or nothing at 0 and once Close put the list away. */
export const statusLine = (turn: Pick<ShellTurn, 'total' | 'isDismissed'>): string | undefined =>
  turn.isDismissed || turn.total === 0 ? undefined : countLine(turn.total)

/** `N earlier commands…`: the line above the rows for the ones the cap leaves out. */
export const earlierLine = (count: number): string => `${count} earlier command${count === 1 ? '' : 's'}…`

/** One row: `$ git status`. */
export const rowLine = (command: Pick<ShellCommand, 'text'>): string => `$ ${command.text}`

/** The word beside a row: nothing for a command that finished, else how it came back. */
export const hintOf = (outcome: CommandOutcome): string => (outcome === 'ran' ? '' : outcome)

// ---------------------------------------------------------------------------
// One command, one line
// ---------------------------------------------------------------------------

/** Terminal escape sequences (CSI, OSC, and the two-character kind): a terminal acts on these, not shows them. */
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g

/** Characters that reorder the text around them, so a row could read differently from what ran. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g

/** A line ended by an odd number of backslashes: the shell reads it and the next line as one line. */
const CONTINUATION = /(?<!\\)((?:\\\\)*)\\\r?\n[ \t]*/g

/** Every control character but the line feed, tab included: each one becomes a space. */
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g

/** Cut to `max` characters, the last of them an ellipsis, never through a surrogate pair. */
export const clip = (text: string, max: number): string => {
  const chars = Array.from(text)

  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/**
 * A command as one row shows it: escape sequences and reordering marks
 * dropped, a backslash-continued line joined to the next, each remaining line
 * break shown as ` ↵ `, runs of spaces folded, and the whole cut at
 * MAX_COMMAND_CHARS. Empty when nothing but space is left.
 */
export const oneLine = (command: string): string => {
  const lines = command
    .replace(ESCAPES, '')
    .replace(BIDI, '')
    .replace(CONTINUATION, '$1 ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')

  return clip(lines.join(LINE_BREAK), MAX_COMMAND_CHARS)
}

// ---------------------------------------------------------------------------
// A Bash call, once its answer is back
// ---------------------------------------------------------------------------

/** What this module reads off a Bash call's input. */
export type BashCall = { tool_use_id?: unknown; command?: unknown; run_in_background?: unknown }

/**
 * How a Bash call's answer says it went, or undefined when the command never
 * ran because a hook refused it (`deny`). An error answer is kept: the
 * command may have run and failed, and the model read an error either way.
 */
export const outcomeOf = (call: BashCall, answer: object): CommandOutcome | undefined => {
  const { deny, isError, result } = answer as { deny?: unknown; isError?: unknown; result?: unknown }
  if (deny !== undefined) return undefined
  if (isError === true) return 'error'
  const record = (typeof result === 'object' && result !== null ? result : {}) as {
    interrupted?: unknown
    backgroundTaskId?: unknown
  }
  if (record.interrupted === true) return 'stopped'
  const isBackground =
    (typeof record.backgroundTaskId === 'string' && record.backgroundTaskId !== '') || call.run_in_background === true

  return isBackground ? 'background' : 'ran'
}

/** The row a Bash call adds, or null: a refused call, or a command with nothing to show. */
export const commandFrom = (call: BashCall, answer: object): ShellCommand | null => {
  const outcome = outcomeOf(call, answer)
  const text = typeof call.command === 'string' ? oneLine(call.command) : ''
  if (outcome === undefined || text === '') return null

  return { id: typeof call.tool_use_id === 'string' ? call.tool_use_id : '', text, outcome }
}

// ---------------------------------------------------------------------------
// This turn
// ---------------------------------------------------------------------------

/** A main-loop turn that has just started: nothing ran yet. */
export const startTurn = (turnId: string): ShellTurn => ({
  turnId,
  commands: [],
  total: 0,
  isDone: false,
  isDismissed: false,
})

/** A main-loop turn as a Bash call finds it when the call starts: which turn, and whether it has ended. */
export type TurnMark = Pick<ShellTurn, 'turnId' | 'isDone'>

/** The mark a stored turn leaves, so a reloaded module knows which turn is current. */
export const markOf = (turn: ShellTurn | null): TurnMark | null =>
  turn === null ? null : { turnId: turn.turnId, isDone: turn.isDone }

/**
 * Whether a call joins the turn it started in: any call that started while
 * the turn ran; once it has ended, only a subagent's. The main loop runs
 * nothing after its turn ends, so a call then without an agent is not this
 * turn's.
 */
export const accepts = (startedIn: Pick<ShellTurn, 'isDone'>, agentId: string | undefined): boolean =>
  !startedIn.isDone || agentId !== undefined

/**
 * The turn with one more command: newest last, the oldest dropped past the
 * cap, every one counted. The same call twice is one row.
 */
export const withCommand = (turn: ShellTurn, command: ShellCommand): ShellTurn => {
  if (command.id !== '' && turn.commands.some(one => one.id === command.id)) return turn
  const id = command.id !== '' ? command.id : `#${turn.total + 1}`

  return {
    ...turn,
    commands: [...turn.commands, { ...command, id }].slice(-MAX_ROWS),
    total: turn.total + 1,
  }
}

export type Card = { rows: readonly ShellCommand[]; earlier: number }

/**
 * How many command rows the band holds without scrolling: what the title and
 * subtitle leave, less one for the earlier count when not every command fits.
 * Never past the cap and never none. A band of unknown height takes the cap.
 */
export const roomFor = (maxRows: number | undefined, total: number): number => {
  const height = typeof maxRows === 'number' && Number.isFinite(maxRows) ? Math.floor(maxRows) : Infinity
  const free = height - HEADER_ROWS
  if (total <= Math.min(free, MAX_ROWS)) return total

  return Math.max(1, Math.min(MAX_ROWS, free - 1))
}

/**
 * The list for a turn, or null: no command yet, or Close put it away. The
 * newest commands that fit, oldest of them first, and a count of the earlier
 * ones left out. A band scrolls a taller tree from its top, so the newest
 * would be the ones out of view; fitting the rows keeps them in it.
 */
export const cardFor = (turn: ShellTurn, maxRows?: number): Card | null => {
  if (turn.isDismissed || turn.total === 0 || turn.commands.length === 0) return null
  const rows = turn.commands.slice(-roomFor(maxRows, turn.total))

  return { rows, earlier: turn.total - rows.length }
}

// ---------------------------------------------------------------------------
// The command and the settings row
// ---------------------------------------------------------------------------

/**
 * The `/config` row this plugin's `enabled` field answers to: a row's key is
 * `<plugin>.<field>`, and a working copy loaded with `--plugin-dir` may carry
 * a suffix on its name (`wait-shell@inline`).
 */
export const ENABLED_ROW = /^wait-shell(@[\w-]+)?\.enabled$/

/** The key `$.config.set` takes for `enabled`, read off the rows `$.config.list()` returns. */
export const enabledRowKey = (rows: readonly { key: string }[]): string =>
  rows.find(row => ENABLED_ROW.test(row.key))?.key ?? 'wait-shell.enabled'

/** What `/wait-shell` answers once it has flipped the setting on. */
export const turnedOnLine = (): string =>
  'on · a list of the shell commands each turn runs · /wait-shell turns it off'

/** What `/wait-shell` answers once the setting is off, and the two places that turn it back on. */
export const turnedOffLine = (): string =>
  `off · /wait-shell turns it back on · /plugin → wait-shell → ${ENABLED_TITLE}`

/** The setting could not be written, but the list is still off on this machine. */
export const turnedOffLocallyLine = (reason: string): string =>
  `off · the setting did not change (${reason}) · kept off on this machine · /wait-shell turns it back on`

/** What `/wait-shell` answers when a turn-on was refused: nothing moved. */
export const toggleRefusedLine = (reason: string): string =>
  `still off · the setting did not change (${reason}) · /plugin → wait-shell → ${ENABLED_TITLE}`

// ---------------------------------------------------------------------------
// The row above the prompt
// ---------------------------------------------------------------------------

/**
 * The waitroom mods that draw into the row above the prompt, the one with
 * precedence first: wait-secret's list with this one last. Theirs end before
 * this list, and a mod a list does not name is behind every mod it does, so
 * their order and this one agree without a change to theirs. While the list
 * waits its turn, the status line carries the count.
 */
export const BAND_PRECEDENCE = [
  'wait-breathe',
  'wait-changed',
  'wait-ship',
  'bet-on-your-agent',
  'wait-scope',
  'wait-secret',
  'wait-shell',
] as const

export type BandMod = (typeof BAND_PRECEDENCE)[number]

/** The plugin whose hook drew a band tree, off the stamp the engine puts on its root. */
export const drawnBy = (tree: unknown): string | undefined => {
  const part = typeof tree === 'object' && tree !== null ? (tree as { part?: { plugin?: unknown } }).part : undefined

  return typeof part?.plugin === 'string' ? part.plugin : undefined
}

/** Whether the row a mod drew beneath `mine` keeps the band: only one ahead of it does. */
export const yieldsBand = (mine: BandMod, beneath: string | undefined): boolean => {
  const at = BAND_PRECEDENCE.indexOf(beneath as BandMod)

  return at !== -1 && at < BAND_PRECEDENCE.indexOf(mine)
}
