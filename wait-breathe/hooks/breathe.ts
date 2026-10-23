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
 * The session-end line, in wait-review's style.
 *
 * `taken` is `undefined` when the surfacing mechanism offered no key to take
 * a break with, in which case the line counts prompts shown alone.
 */
export const sessionSummaryLine = (shown: number, taken: number | undefined): string =>
  taken === undefined
    ? `breathe: ${shown} prompt${shown === 1 ? '' : 's'} this session`
    : `breathe: ${shown} prompt${shown === 1 ? '' : 's'}, ${taken} taken this session`

/** A positive whole number from config, or `fallback` for anything else. */
export const wholePositive = (value: unknown, fallback: number): number => {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * The one-line answer to "is this even on": current state, the threshold it
 * acts on either way, and exactly where to flip it. `/breathe` is this
 * plugin's only way to be found once the install screen has scrolled by.
 */
export const statusLine = (enabled: boolean, longTurnSeconds: number): string =>
  enabled
    ? `breathe: on · nudges after a turn runs ${longTurnSeconds}s · turn off in /plugin → wait-breathe → Enable the breathing nudges`
    : `breathe: off · would nudge after a turn runs ${longTurnSeconds}s · turn on in /plugin → wait-breathe → Enable the breathing nudges`
