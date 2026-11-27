import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { isCalibrating, MIN_SCORED, report } from '../hooks/bet'
import type { BetRecord } from '../hooks/record'
import { betRecordOf, readBetRecord } from '../hooks/record'

let next = 0
const turn = (over: Partial<TurnRecord> = {}): TurnRecord => {
  next++

  return {
    turnId: `t${next}`,
    at: next * 1000,
    durationMs: 30000,
    files: 2,
    filesBucket: '2-3',
    toolCalls: 0,
    isAborted: false,
    ...over,
  }
}

/**
 * A `$` with nothing on it but a store, answering `get` from `entries`.
 *
 * `set` and `delete` are there to be seen untouched: the reader only reads,
 * and a stored value it cannot use is left where it is.
 */
const storeOf = (entries: Record<string, unknown>) => {
  const writes: string[] = []
  const $ = {
    store: {
      get: async (key: string): Promise<unknown> => entries[key],
      set: async (key: string, _value: unknown) => {
        writes.push(key)
      },
      delete: async (key: string) => {
        writes.push(key)
      },
    },
  }

  return { $, writes }
}

/** The reader's calibration is report()'s own, number for number, on the same turns. */
const expectReportNumbers = (view: BetRecord, records: readonly TurnRecord[]) => {
  const found = report(records)

  expect(view.scored).toBe(found.scored)
  expect(view.recorded).toBe(found.recorded)
  expect(view.brier).toBe(found.brier)
  expect(view.rank).toBe(found.rank)
  expect(view.rows).toEqual(found.rows)
  expect(view.isCalibrating).toBe(isCalibrating(found))
}

test('no history is an empty record: no calls, nothing scored, no score, Unranked', async () => {
  const view = betRecordOf([])

  expect(view.turns).toEqual([])
  expect(view.calls).toEqual([])
  expect(view.scored).toBe(0)
  expect(view.recorded).toBe(0)
  expect(view.brier).toBeUndefined()
  expect(view.rank).toBe('Unranked')
  expect(view.rows).toEqual([])
  // Nothing scored yet is the start of calibrating, as `/bet` counts it.
  expect(view.isCalibrating).toBe(true)
  expectReportNumbers(view, [])
})

test('a missing key, an unset value and an empty list all read as the empty record', async () => {
  const empty = betRecordOf([])

  expect(await readBetRecord(storeOf({}).$)).toStrictEqual(empty)
  expect(await readBetRecord(storeOf({ turns: undefined }).$)).toStrictEqual(empty)
  expect(await readBetRecord(storeOf({ turns: [] }).$)).toStrictEqual(empty)
})

test('one call reads back its forecast, its outcome and when, scored as report() scores it', async () => {
  const records = [turn({ turnId: 'only', at: 1_800_000_000_000, saidConfidence: 0.8, landed: true })]
  const view = betRecordOf(records)

  expect(view.calls).toStrictEqual([{ turnId: 'only', at: 1_800_000_000_000, saidConfidence: 0.8, outcome: 'landed' }])
  // The stored turn comes along whole, for what the call leaves out.
  expect(view.turns).toStrictEqual(records)
  // (0.8 − 1)²: one call scored, too few to rank or to read a lean from.
  expect(view.brier?.toFixed(3)).toBe('0.040')
  expect(view.scored).toBe(1)
  expect(view.recorded).toBe(1)
  expect(view.rank).toBe('Unranked')
  expect(view.isCalibrating).toBe(true)
  expect(view.rows).toStrictEqual([{ said: 0.8, actual: 1, turns: 1, lean: 'under' }])
  expectReportNumbers(view, records)

  // Read out of the store, the same turn is the same record.
  expect(await readBetRecord(storeOf({ turns: records }).$)).toStrictEqual(view)
})

test('the outcome is the verdict in the row’s own words, and absent until there is one', async () => {
  const { calls } = betRecordOf([
    turn({ turnId: 'landed', at: 1, saidConfidence: 0.9, landed: true }),
    turn({ turnId: 'fixed', at: 2, saidConfidence: 0.9, landed: false }),
    turn({ turnId: 'owed', at: 3, saidConfidence: 0.9 }),
    turn({ turnId: 'skipped', at: 4, saidConfidence: 0.9, isVerdictSkipped: true }),
    // A skip is no verdict, as the score reads it, even beside one from before it.
    turn({ turnId: 'stale', at: 5, saidConfidence: 0.9, landed: false, isVerdictSkipped: true }),
    turn({ turnId: 'unbet', at: 6 }),
  ])

  // `1: Landed  2: Needed fixing`, one entry per turn, in the order they ran.
  expect(calls).toStrictEqual([
    { turnId: 'landed', at: 1, saidConfidence: 0.9, outcome: 'landed' },
    { turnId: 'fixed', at: 2, saidConfidence: 0.9, outcome: 'needed-fixing' },
    { turnId: 'owed', at: 3, saidConfidence: 0.9 },
    { turnId: 'skipped', at: 4, saidConfidence: 0.9 },
    { turnId: 'stale', at: 5, saidConfidence: 0.9 },
    // Nobody bet on it: still a turn on the record, with no call.
    { turnId: 'unbet', at: 6 },
  ])
})

test('many calls: mixed verdicts and unscored turns, calibrated and ranked as report() does it', async () => {
  const records = [
    ...Array.from({ length: 20 }, () => turn({ saidConfidence: 0.9, landed: true })),
    turn(),
    turn({ saidConfidence: 0.8 }),
    turn({ saidConfidence: 0.65, isVerdictSkipped: true }),
    turn({ saidConfidence: 0.95, isAborted: true }),
    ...Array.from({ length: 5 }, () => turn({ saidConfidence: 0.8, landed: false })),
    ...Array.from({ length: 5 }, () => turn({ saidConfidence: 0.5, landed: true })),
  ]
  const view = betRecordOf(records)

  expect(view.recorded).toBe(34)
  // The turn nobody bet on, the one still owed, the skip and the interrupted
  // one are on the record, and none of them is scored.
  expect(view.scored).toBe(30)
  expect(view.isCalibrating).toBe(false)
  // The Brier score is the lifetime one, over all thirty scored calls...
  expect(view.brier?.toFixed(3)).toBe('0.155')
  // ...and the rank reads the last 20 alone (0.228), the oldest good calls aged out.
  expect(view.rank).toBe('Silver')
  // One row per forecast scored: 65% and 95% were only bet on turns that never were.
  expect(view.rows.map(row => [row.said, row.turns, row.lean])).toEqual([
    [0.5, 5, 'under'],
    [0.8, 5, 'over'],
    [0.9, 20, 'under'],
  ])
  expect(view.calls.map(one => one.turnId)).toEqual(records.map(one => one.turnId))
  expect(view.calls.filter(one => one.outcome === 'landed')).toHaveLength(25)
  expect(view.calls.filter(one => one.outcome === 'needed-fixing')).toHaveLength(5)
  expect(view.calls.filter(one => one.outcome === undefined)).toHaveLength(4)
  expectReportNumbers(view, records)

  // At every point along the way too: the running score is report()'s own,
  // through the fifth scored call and past the twentieth.
  for (let at = 0; at <= records.length; at++) {
    expectReportNumbers(betRecordOf(records.slice(0, at)), records.slice(0, at))
  }

  expect(await readBetRecord(storeOf({ turns: records }).$)).toStrictEqual(view)
})

test('it is calibrating until five calls are scored, then ranked', async () => {
  const scored = Array.from({ length: MIN_SCORED }, () => turn({ saidConfidence: 0.9, landed: true }))
  const owed = turn({ saidConfidence: 0.9 })

  const almost = betRecordOf([...scored.slice(1), owed])
  expect(almost.scored).toBe(MIN_SCORED - 1)
  expect(almost.isCalibrating).toBe(true)
  expect(almost.rank).toBe('Unranked')

  const enough = betRecordOf([...scored, owed])
  expect(enough.scored).toBe(MIN_SCORED)
  expect(enough.isCalibrating).toBe(false)
  // Every call at 90% and every one landed: 0.010, the top rank.
  expect(enough.rank).toBe('Oracle')
})

test('a store that throws on the read is the empty record, not an error', async () => {
  const empty = betRecordOf([])
  const rejects = {
    store: {
      get: async (): Promise<unknown> => {
        throw new Error('EIO: store unreadable for a moment')
      },
    },
  }
  const throwsAtOnce = {
    store: {
      get: (): Promise<unknown> => {
        throw new Error('EIO: store unreadable for a moment')
      },
    },
  }

  expect(await readBetRecord(rejects)).toStrictEqual(empty)
  expect(await readBetRecord(throwsAtOnce)).toStrictEqual(empty)
})

test('a stored history that is not a list reads as empty, and is left where it is', async () => {
  const empty = betRecordOf([])

  for (const value of ['not a list', 42, true, null, { turns: [] }]) {
    const { $, writes } = storeOf({ turns: value })

    expect(await readBetRecord($)).toStrictEqual(empty)
    // Nothing repaired, nothing written over: that is the hooks module's call.
    expect(writes).toEqual([])
  }
})

test('a null in the list is dropped on its own, and the turns around it still read', async () => {
  const first = turn({ turnId: 'first', saidConfidence: 0.8, landed: true })
  const owed = turn({ turnId: 'owed', saidConfidence: 0.6 })
  const last = turn({ turnId: 'last', saidConfidence: 0.7, landed: false })
  const good = [first, owed, last]
  // report() throws on the null: one bad entry used to cost the whole history.
  const stored = [first, null, owed, last]
  const { $, writes } = storeOf({ turns: stored })

  const view = await readBetRecord($)

  expect(view).toStrictEqual(betRecordOf(good))
  expect(view.calls).toStrictEqual([
    { turnId: 'first', at: first.at, saidConfidence: 0.8, outcome: 'landed' },
    { turnId: 'owed', at: owed.at, saidConfidence: 0.6 },
    { turnId: 'last', at: last.at, saidConfidence: 0.7, outcome: 'needed-fixing' },
  ])
  expect(view.recorded).toBe(3)
  expect(view.scored).toBe(2)
  expectReportNumbers(view, good)
  // Nothing repaired, nothing written over: the null stays where it was.
  expect(stored).toStrictEqual([first, null, owed, last])
  expect(writes).toEqual([])

  // Turns already loaded read the same, for a caller with a list of its own.
  expect(betRecordOf(stored as TurnRecord[])).toStrictEqual(view)
})

test('anything else in the list that is not a turn object is dropped the same way', async () => {
  const first = turn({ saidConfidence: 0.9, landed: true })
  const last = turn({ saidConfidence: 0.6, landed: false })

  // `undefined` throws as `null` does; the others would each read as a turn with nothing on it.
  for (const stray of [undefined, 'not a turn', 42, true, []]) {
    const { $, writes } = storeOf({ turns: [first, stray, last] })

    expect(await readBetRecord($)).toStrictEqual(betRecordOf([first, last]))
    expect(writes).toEqual([])
  }
})

test('the turns it hands back are a copy: pushing onto them or sorting them changes nothing stored', async () => {
  const records = [turn({ saidConfidence: 0.8, landed: true }), turn({ saidConfidence: 0.6, landed: false })]
  const stored = [...records]
  const { $, writes } = storeOf({ turns: stored })

  // `readonly` is only the type's word for it: at run time a caller can still push and sort.
  const handedBack = (await readBetRecord($)).turns as TurnRecord[]
  handedBack.push(turn({ saidConfidence: 0.9, landed: true }))
  handedBack.sort((a, b) => b.at - a.at)

  expect(stored).toStrictEqual(records)
  // The next read is the store's own history, not the one a caller changed.
  const again = await readBetRecord($)
  expect(again.turns).toStrictEqual(records)
  expect(again).toStrictEqual(betRecordOf(records))
  expect(writes).toEqual([])

  // From turns already loaded, the caller's own list is left alone the same way.
  const mine = [...records]
  const fromLoaded = betRecordOf(mine).turns as TurnRecord[]
  fromLoaded.push(turn())
  fromLoaded.sort((a, b) => b.at - a.at)
  expect(mine).toStrictEqual(records)
})
