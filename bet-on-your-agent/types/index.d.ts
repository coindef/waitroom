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
 * The rotating bonus question's own dimension: which thing besides land/fail
 * is being forecast this turn.
 */
export type BonusDim = 'duration' | 'files' | 'toolCalls'

/**
 * Every bucket label across every bonus dimension, in one type, so a
 * `TurnRecord`'s guess and its outcome share a type regardless of which
 * dimension was asked that turn.
 */
export type BonusBucket = '<30s' | '30-90s' | '>90s' | '1' | '2-3' | '4+' | '0-2' | '3-6' | '7+'

/**
 * A calibration rank, worst to best, from the rolling Brier score.
 *
 * `Unranked` is not the worst rank, it is no rank: too few scored turns for
 * the number to mean anything yet.
 */
export type Rank = 'Unranked' | 'Coin-Flipper' | 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Oracle'

/** A climb from one rank to a better one, worth a celebratory line once. */
export type RankChange = { from: Rank; to: Rank }

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
  /** Tool calls the turn made, of any kind, counted whether denied or not. */
  toolCalls: number
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
  /** Which bonus question this turn's rotation landed on; absent on a turn before this feature shipped. */
  bonusDim?: BonusDim
  /** The person's guess at that dimension; absent when the bonus was skipped. */
  saidBonus?: BonusBucket
  /** How that dimension actually turned out, set whenever `bonusDim` is. */
  bonusActual?: BonusBucket
}

/** The most recent verdict given, kept so one press can take it back. */
export type LastVerdict = {
  turnId: string
  result: 'landed' | 'fixed' | 'skipped'
  /** Set when this verdict's score pushed the rolling rank up a level. */
  rankUp?: RankChange
}

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
  /** Tool calls made so far this turn, of any kind. */
  toolCalls: number
  /** Which dimension this turn's rotation offers as the bonus question. */
  bonusDim?: BonusDim
  /** The person's guess at `bonusDim`; absent until they answer. */
  saidBonus?: BonusBucket
  /**
   * Set when the person waved the bonus question away.
   *
   * Its own skip, separate from `isDeclined`: passing on the bonus costs
   * nothing and says nothing about the main bet.
   */
  isBonusDeclined?: true
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
      /**
       * How many turns have offered a bonus question, counted forever rather
       * than off the history array's own length: that array is capped at 500,
       * so past the cap its length stops growing and the rotation would stall
       * on whichever dimension the cap landed on.
       */
      bonusRotation: number
      /**
       * When this session began, epoch milliseconds; null until `session.start`
       * has set it once. The recap card's "this session" is every record at or
       * after this.
       */
      sessionStartedAt: number | null
    }
  }
}
