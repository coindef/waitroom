/**
 * Pure breathe logic: no engine, no $, so `claude plugin test` exercises it
 * directly.
 */

/**
 * The rotating nudges. Each names the action only — no health claim, no
 * medical advice, no benefit promised — and the four are distinct enough
 * that a round-robin through them never repeats one back to back.
 */
export const MESSAGES = [
  'posture check: reset how you are sitting',
  '20-20-20: look at something about 20 feet away for 20 seconds',
  '4-4-4 breathing: in for 4, hold for 4, out for 4',
  'stand up and stretch',
] as const

/** The message for a given rotation count, wrapping forever. */
export const messageAt = (rotation: number): string => {
  const at = ((rotation % MESSAGES.length) + MESSAGES.length) % MESSAGES.length

  return MESSAGES[at] as string
}

/** How long one shown prompt blocks the next, regardless of which turn asks. */
export const COOLDOWN_MS = 10 * 60 * 1000

/** Whether enough time has passed since the last prompt to show another. */
export const canPrompt = (lastPromptAt: number | null, now: number): boolean =>
  lastPromptAt === null || now - lastPromptAt >= COOLDOWN_MS

/** One prompt's outcome, kept only long enough to count it in a session's summary. */
export type PromptEvent = { at: number; taken: boolean }

/** The one record in `$.store`: rotation, cooldown, and the history the summary counts. */
export type BreatheStore = { rotation: number; lastPromptAt: number | null; history: PromptEvent[] }

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isPromptEvent = (value: unknown): value is PromptEvent => {
  if (typeof value !== 'object' || value === null) return false
  const event = value as { at?: unknown; taken?: unknown }

  return isFiniteNumber(event.at) && typeof event.taken === 'boolean'
}

/**
 * A stored record this mod wrote. Undefined when a value is present but is
 * not that record: not an object, a missing field, or a history that is not
 * a list of prompt events. A failed read is not this function's job.
 */
export const storeFrom = (raw: unknown): BreatheStore | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as { rotation?: unknown; lastPromptAt?: unknown; history?: unknown }
  if (!isFiniteNumber(row.rotation)) return undefined
  if (!(row.lastPromptAt === null || isFiniteNumber(row.lastPromptAt))) return undefined
  if (!Array.isArray(row.history) || !row.history.every(isPromptEvent)) return undefined

  return row as BreatheStore
}

/** Appends `event`, capped newest-last so a long-lived store does not grow forever. */
export const keepHistory = (
  history: readonly PromptEvent[],
  event: PromptEvent,
  limit = 500,
): PromptEvent[] => [...history, event].slice(-limit)

/** Prompts shown and taken from `sessionStartedAt` on, for the session-end line. */
export const sessionCountsOf = (
  history: readonly PromptEvent[],
  sessionStartedAt: number | null,
): { shown: number; taken: number } => {
  const inSession = sessionStartedAt === null ? history : history.filter(one => one.at >= sessionStartedAt)

  return { shown: inSession.length, taken: inSession.filter(one => one.taken).length }
}

/**
 * The session-end line, in wait-review's style. The engine already puts
 * `wait-breathe:` in front of it, so it does not name the plugin again.
 *
 * `taken` is `undefined` when the surfacing mechanism offered no key to take
 * a break with, in which case the line counts nudges shown alone.
 */
export const sessionSummaryLine = (shown: number, taken: number | undefined): string =>
  taken === undefined
    ? `${shown} nudge${shown === 1 ? '' : 's'} this session`
    : `${shown} nudge${shown === 1 ? '' : 's'}, ${taken} taken this session`

/** A positive whole number from config, or `fallback` for anything else. */
export const wholePositive = (value: unknown, fallback: number): number => {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * What `/breathe` answers once it has flipped the setting: the state it is in
 * now, the threshold it acts on while on, and that the same command flips it
 * back — one key either way, and no reason given for either choice. It starts
 * at the state because the engine prints it as `wait-breathe: on · …`.
 */
export const toggledLine = (enabled: boolean, longTurnSeconds: number): string =>
  enabled
    ? `on · one quiet nudge once a turn runs ${longTurnSeconds}s · /breathe again turns it off`
    : 'off · /breathe turns it on'

/** What `/breathe` answers when the setting could not be changed: nothing moved, and where else it lives. */
export const toggleRefusedLine = (enabled: boolean, reason: string): string =>
  `still ${enabled ? 'on' : 'off'} · the setting did not change (${reason}) · ` +
  '/plugin → wait-breathe → Enable the breathing nudges'

/**
 * The `/config` row this plugin's `enabled` field answers to: a row's key is
 * `<plugin>.<field>`, and a working copy loaded with `--plugin-dir` may carry
 * a suffix on its name (`wait-breathe@inline`).
 */
export const ENABLED_ROW = /^wait-breathe(@[\w-]+)?\.enabled$/

/** The key `$.config.set` takes for `enabled`, read off the rows `$.config.list()` returns. */
export const enabledRowKey = (rows: readonly { key: string }[]): string =>
  rows.find(row => ENABLED_ROW.test(row.key))?.key ?? 'wait-breathe.enabled'

/**
 * Who a band drawing is owed to.
 *
 * On Claude Code 2.1.319 the engine stamps `part.plugin` on the root
 * `next(e)` returns, and a hook that passes that tree on leaves the stamp.
 * On 2.1.325 each AbovePrompt row is `{ plugin, tree }` on AbovePromptList's
 * `e.props.rows`. `{ type: "engine", ref }` is core's own drawing and names
 * nobody.
 */
export const drawnBy = (tree: unknown): string | undefined => {
  if (typeof tree !== 'object' || tree === null) return undefined
  const row = tree as { plugin?: unknown; tree?: unknown; part?: { plugin?: unknown } }
  if (typeof row.plugin === 'string' && typeof row.tree === 'object' && row.tree !== null) return row.plugin

  return typeof row.part?.plugin === 'string' ? row.part.plugin : undefined
}

/**
 * Which of the rows `AbovePromptList` handed over stay on the band.
 *
 * Claude Code 2.1.325 asks every AbovePrompt hook for its own row and stacks
 * whatever comes back. `next(e)` is core's `{ type: "engine", ref }` and names
 * no plugin, so a hook cannot yield from it. Leaving rows out of
 * AbovePromptList is how one mod yields to another: pass these same row
 * objects on, and nothing else. 2.1.319 does not raise that event; there
 * `drawnBy` still reads `part.plugin` off `next(e)`.
 *
 * One waitroom row, earliest first: breathe, ship, bet, scope, secret. While
 * a turn runs the bet's forecast comes ahead of a ship offer and still behind
 * a breathe nudge. A row from outside this list stays only when none of these
 * drew.
 */
const ROW_ORDER = ['wait-breathe', 'wait-ship', 'bet-on-your-agent', 'wait-scope', 'wait-secret'] as const

export const rowsKept = <T extends { plugin?: unknown; tree?: unknown }>(
  rows: readonly T[],
  isWorking: boolean,
): readonly T[] => {
  const present = (name: string) => rows.some(row => drawnBy(row) === name)
  const winner = present('wait-breathe')
    ? 'wait-breathe'
    : isWorking && present('bet-on-your-agent')
      ? 'bet-on-your-agent'
      : ROW_ORDER.find(name => present(name))

  if (winner === undefined) return rows

  return rows.filter(row => drawnBy(row) === winner)
}
