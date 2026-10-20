/**
 * bet-on-your-agent's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/** How many files a turn was forecast, or found, to touch. */
export type FileBucket = '0' | '1' | '2-3' | '4+'

/**
 * One turn, as it was forecast and as it turned out.
 *
 * `saidConfidence` and `saidFiles` are absent on a turn nobody bet on, and
 * `landed` stays absent until the person gives their verdict, so a record can
 * hold facts without being scorable.
 */
export type TurnRecord = {
  turnId: string
  /** When the turn ended, epoch milliseconds. */
  at: number
  durationMs: number
  /** Distinct files the turn wrote. */
  files: number
  filesBucket: FileBucket
  /** An interrupted turn is recorded but never scored. */
  isAborted: boolean
  /**
   * The opening of the prompt that started the turn.
   *
   * What anchors a forecast to something: a score says you are overconfident,
   * this says overconfident about what.
   */
  ask?: string
  /** The forecast, 0 to 1; absent when no bet was placed. */
  saidConfidence?: number
  saidFiles?: FileBucket
  /** The person's verdict; absent until they give it. */
  landed?: boolean
  /**
   * Set when the person waved the verdict away.
   *
   * Kept rather than deleted so the turn still counts as recorded, but it owes
   * nothing and is never scored.
   */
  isVerdictSkipped?: true
}

/** The most recent verdict given, kept so one press can take it back. */
export type LastVerdict = { turnId: string; result: 'landed' | 'fixed' | 'skipped' }

/** The bet on the turn now running. */
export type OpenBet = {
  turnId: string
  /** The opening of the prompt that started this turn. */
  ask: string
  /** Distinct paths written so far this turn. */
  files: string[]
  /**
   * What git saw changed when the turn started: path to content hash.
   *
   * An agent writes through a shell as often as through Edit, and only git
   * sees both, so the turn's files include every one whose content moved from
   * this. Absent outside a repository, where the tool calls are all there is.
   */
  baseline?: Record<string, string>
  saidConfidence?: number
  saidFiles?: FileBucket
  /**
   * Set when the person waved this turn's bet away.
   *
   * A prompt you cannot dismiss is a nag, so the band gets out of the way for
   * the rest of the turn rather than holding its buttons up unanswered.
   */
  isDeclined?: true
}

declare module 'claude-code' {
  interface PluginState {
    'bet-on-your-agent': {
      open: OpenBet
      busy: boolean
      lastVerdict: LastVerdict | null
      /**
       * Bumped whenever the store changes.
       *
       * A `$.store` read does not subscribe a drawing the way a `$.state` read
       * does, so the sites read this to be redrawn when a record lands.
       */
      revision: number
    }
  }
}
