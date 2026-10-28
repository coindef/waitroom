/**
 * The first-session tip: no engine, no $, so `claude plugin test` exercises
 * the once-rule directly.
 */

/**
 * The three facts, one transcript line each.
 *
 * Locked copy. `$.ui.log` takes one string, so each line is its own call
 * and the punctuation stays as written.
 */
export const FIRST_SESSION_TIP = [
  'Waitroom ready: wait-review · bet-on-your-agent · wait-ship · wait-breathe.',
  'wait-breathe stays off until /breathe.',
  'Optional turn-end file list (not in this install): claude plugin install wait-changed@waitroom',
] as const

/** `$.store` key. `true` once the tip has been written, and then forever. */
export const TIP_SHOWN_KEY = 'tip-shown'

/**
 * Whether this start should write the tip.
 *
 * Interactive only, and only while the store has not recorded it. A missing
 * key is a fresh install. A non-interactive start does not spend the showing.
 */
export const shouldShowTip = (isInteractive: boolean, stored: unknown): boolean =>
  isInteractive && stored !== true
