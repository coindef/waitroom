/**
 * The bet record, read back for whatever shows it: each turn's call, how it
 * came out and when, beside the calibration `/bet` prints. One module, so no
 * card or mod reads the store its own way or scores a call differently.
 *
 * Read-only. It never repairs the store or writes it, and its read never
 * throws: what it cannot read is an empty record. The repair, and keeping
 * the last good history on screen through a failed read, stay with the hooks
 * module's own read (`loadTurns` and `turnsToShow` in register.tsx).
 */

import type { EngineInterface } from 'claude-code'

import type { Rank, TurnRecord } from '../types'
import type { CalibrationRow } from './bet'
import { isCalibrating, report } from './bet'
import { TURNS_STORE_KEY } from './store-keys'

/** How a turn came out, by the person's own verdict: `1: Landed` or `2: Needed fixing`. */
export type BetOutcome = 'landed' | 'needed-fixing'

/** One turn as the record reads it back: the call, how it came out, and when. */
export type BetCall = {
  turnId: string
  /** When the turn ended, epoch milliseconds. */
  at: number
  /** The forecast, 0 to 1; absent on a turn nobody bet on. */
  saidConfidence?: number
  /** The verdict; absent until there is one, and on a verdict waved away. */
  outcome?: BetOutcome
}

/**
 * The whole record: every turn, each one's call, and the running
 * calibration, which is `report()`'s own numbers so it never drifts from
 * what `/bet` says.
 */
export type BetRecord = {
  /**
   * The turn history as stored, oldest first, for whatever a call leaves out.
   * A copy, without any entry that is not a turn.
   */
  turns: readonly TurnRecord[]
  /** One per turn, bet on or not, in the same order as `turns`. */
  calls: readonly BetCall[]
  /** Turns a forecast was scored on. */
  scored: number
  /** Turns recorded at all, bet on or not. */
  recorded: number
  /** The lifetime Brier score, over every scored turn; absent until one is scored. */
  brier?: number
  /** Where the rolling Brier score over the last 20 scored turns ranks. */
  rank: Rank
  /** Under five scored calls, where `/bet` counts up instead of judging. */
  isCalibrating: boolean
  /** One row per forecast scored, lowest first: what was said against what happened. */
  rows: readonly CalibrationRow[]
}

/** A skip is no verdict, as the score reads it, whatever was answered before it. */
const outcomeOf = (one: TurnRecord): BetOutcome | undefined => {
  if (one.isVerdictSkipped === true) return undefined
  if (one.landed === true) return 'landed'

  return one.landed === false ? 'needed-fixing' : undefined
}

const callOf = (one: TurnRecord): BetCall => {
  const outcome = outcomeOf(one)

  return {
    turnId: one.turnId,
    at: one.at,
    ...(one.saidConfidence === undefined ? {} : { saidConfidence: one.saidConfidence }),
    ...(outcome === undefined ? {} : { outcome }),
  }
}

/**
 * Whether an entry is a turn at all: an object, and not a list. The hooks
 * module only ever saves whole turns. `null`, a string or a number among
 * them is not one, and `null` is what `report()` throws on. A turn missing a
 * field still reads, as it does in `report()`.
 */
const isTurn = (one: unknown): one is TurnRecord => typeof one === 'object' && one !== null && !Array.isArray(one)

/**
 * The record from turns already loaded. No turns is the empty record, the
 * numbers `report([])` gives: nothing scored, no Brier, `Unranked`, no rows,
 * still calibrating.
 *
 * An entry that is not a turn is left out on its own, so one bad entry never
 * empties the record. `turns` is a copy, never the list passed in: sorting it
 * or pushing onto it leaves that list, and the store's, as they were.
 */
export const betRecordOf = (records: readonly TurnRecord[]): BetRecord => {
  // The filter is the copy too: `readonly` holds only in the types.
  const turns = records.filter(isTurn)
  const found = report(turns)

  return {
    turns,
    calls: turns.map(callOf),
    scored: found.scored,
    recorded: found.recorded,
    ...(found.brier === undefined ? {} : { brier: found.brier }),
    rank: found.rank,
    isCalibrating: isCalibrating(found),
    rows: found.rows,
  }
}

/** All the reader takes of `$`: the store's `get`, and nothing that could write. */
type StoreReader = { readonly store: Pick<EngineInterface['store'], 'get'> }

/**
 * The record as the store holds it now: no key yet is no turns.
 *
 * An entry in the list that is not a turn costs only itself. A read that
 * throws, a stored value that is not a list, or a list that still cannot be
 * scored is the empty record, never a throw. Whatever is stored stays
 * exactly as it was.
 */
export const readBetRecord = async ($: StoreReader): Promise<BetRecord> => {
  try {
    const stored = await $.store.get(TURNS_STORE_KEY)

    return betRecordOf(Array.isArray(stored) ? (stored as TurnRecord[]) : [])
  } catch {
    return betRecordOf([])
  }
}
