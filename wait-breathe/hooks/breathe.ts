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
