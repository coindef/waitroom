import { expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import {
  asDuration,
  askRoomFor,
  calibrationLine,
  CALIBRATION_HEAD,
  asText,
  bucketOf,
  calibration,
  changedSince,
  COIN_FLIP_BRIER,
  FILE_LABELS,
  filesPhrase,
  headline,
  keepRecord,
  lapseVerdicts,
  median,
  owedVerdict,
  parseStatus,
  report,
  setVerdict,
  shortAsk,
  skipVerdict,
  undoVerdict,
  VERDICT_CHROME,
  VERDICT_WINDOW_MS,
  worstCalls,
} from '../hooks/bet'

let next = 0
const turn = (over: Partial<TurnRecord> = {}): TurnRecord => {
  next++

  return {
    turnId: `t${next}`,
    at: next * 1000,
    durationMs: 30000,
    files: 2,
    filesBucket: '2-3',
    isAborted: false,
    ...over,
  }
}

test('a file count falls in the bucket that covers it', async () => {
  expect(bucketOf(0)).toBe('0')
  expect(bucketOf(1)).toBe('1')
  expect(bucketOf(2)).toBe('2-3')
  expect(bucketOf(3)).toBe('2-3')
  expect(bucketOf(4)).toBe('4+')
  expect(bucketOf(40)).toBe('4+')
  // A negative count is not reachable, but it must not fall through to '4+'.
  expect(bucketOf(-1)).toBe('0')
})

test('saying 50% every time scores exactly a coin flip', async () => {
  const found = report([
    turn({ saidConfidence: 0.5, landed: true }),
    turn({ saidConfidence: 0.5, landed: false }),
  ])

  expect(found.brier).toBe(COIN_FLIP_BRIER)
})

test('a forecaster who is always right scores zero', async () => {
  const found = report([
    turn({ saidConfidence: 1, landed: true }),
    turn({ saidConfidence: 0, landed: false }),
  ])

  expect(found.brier).toBe(0)
})

test('overconfidence shows up as the score, the lean and the gap', async () => {
  // Four turns called at 90%, two of which landed: (0.01 + 0.01 + 0.81 + 0.81) / 4.
  const found = report([
    turn({ saidConfidence: 0.9, landed: true }),
    turn({ saidConfidence: 0.9, landed: true }),
    turn({ saidConfidence: 0.9, landed: false }),
    turn({ saidConfidence: 0.9, landed: false }),
  ])

  expect(found.brier?.toFixed(3)).toBe('0.410')
  expect(found.brier).toBeGreaterThan(COIN_FLIP_BRIER)
  expect(found.lean).toBe('over')
  expect(found.gap).toBe(40)
  expect(found.scored).toBe(4)
})

test('underconfidence leans the other way', async () => {
  const found = report([
    turn({ saidConfidence: 0.5, landed: true }),
    turn({ saidConfidence: 0.5, landed: true }),
    turn({ saidConfidence: 0.5, landed: true }),
    turn({ saidConfidence: 0.5, landed: true }),
  ])

  expect(found.lean).toBe('under')
  expect(found.gap).toBe(-50)
})

test('a forecast within the slack counts as honest, not as a lean', async () => {
  const found = report([
    turn({ saidConfidence: 0.5, landed: true }),
    turn({ saidConfidence: 0.5, landed: false }),
  ])

  expect(found.lean).toBe('fair')
})

test('an interrupted turn is recorded but never scored', async () => {
  const found = report([
    turn({ saidConfidence: 0.9, landed: false, isAborted: true }),
    turn({ saidConfidence: 0.9, landed: true }),
  ])

  // Stopping a turn yourself says nothing about the agent.
  expect(found.scored).toBe(1)
  expect(found.recorded).toBe(2)
  expect(found.brier?.toFixed(3)).toBe('0.010')
})

test('a bet with no verdict waits rather than counting as a loss', async () => {
  const found = report([
    turn({ saidConfidence: 0.8 }),
    turn({ saidConfidence: 0.8, landed: true }),
  ])

  expect(found.scored).toBe(1)
  expect(found.owed).toBe(1)
})

test('a turn nobody bet on is recorded and owes nothing', async () => {
  const found = report([turn(), turn()])

  expect(found.recorded).toBe(2)
  expect(found.scored).toBe(0)
  expect(found.owed).toBe(0)
  expect(found.brier).toBeUndefined()
})

test('the calibration table has one row per forecast used, lowest first', async () => {
  const rows = calibration([
    turn({ saidConfidence: 0.9, landed: false }),
    turn({ saidConfidence: 0.5, landed: true }),
    turn({ saidConfidence: 0.9, landed: true }),
  ])

  expect(rows.map(row => row.said)).toEqual([0.5, 0.9])
  expect(rows[1]?.turns).toBe(2)
  expect(rows[1]?.actual).toBe(0.5)
  expect(rows[1]?.lean).toBe('over')
})

test('the file forecast is scored on the exact bucket', async () => {
  const found = report([
    turn({ saidFiles: '2-3', filesBucket: '2-3' }),
    turn({ saidFiles: '1', filesBucket: '4+' }),
    turn({ filesBucket: '0' }),
  ])

  expect(found.files).toEqual({ right: 1, of: 2 })
})

test('git status entries are read whole, renames by their new path', async () => {
  const out = [' M src/retry.ts', '?? notes/new file.md', ' D old.ts', 'R  src/moved.ts', 'src/was.ts', ''].join('\0')

  expect(parseStatus(out)).toEqual([
    { path: 'src/retry.ts', isDeleted: false },
    { path: 'notes/new file.md', isDeleted: false },
    { path: 'old.ts', isDeleted: true },
    { path: 'src/moved.ts', isDeleted: false },
  ])
  expect(parseStatus('')).toEqual([])
})

test('a file counts as written when its content moved, appeared, or was changed back', async () => {
  const before = { '/r/a.ts': 'h1', '/r/b.ts': 'h2', '/r/c.ts': 'h3' }
  const after = { '/r/a.ts': 'h1', '/r/b.ts': 'h9', '/r/d.ts': 'h4' }

  // a is untouched; b changed; c was changed back to clean; d is new.
  expect(changedSince(before, after).sort()).toEqual(['/r/b.ts', '/r/c.ts', '/r/d.ts'])
  expect(changedSince({}, {})).toEqual([])
})

test('the median turn is the middle one, and the mean of two in the middle', async () => {
  expect(median([10, 30, 20])).toBe(20)
  expect(median([10, 20, 30, 40])).toBe(25)
  expect(median([])).toBeUndefined()
})

test('a turn is stored once, however often it is written', async () => {
  const first = keepRecord([], turn({ turnId: 'a', files: 1 }))
  const again = keepRecord(first, turn({ turnId: 'a', files: 9 }))

  expect(again).toHaveLength(1)
  expect(again[0]?.files).toBe(9)
})

test('history is capped, oldest dropped first', async () => {
  let records: TurnRecord[] = []
  for (let at = 0; at < 8; at++) records = keepRecord(records, turn({ turnId: `k${at}` }), 5)

  expect(records).toHaveLength(5)
  expect(records[0]?.turnId).toBe('k3')
  expect(records[4]?.turnId).toBe('k7')
})

test('a verdict lands on its own turn and no other', async () => {
  const records = [turn({ turnId: 'a', saidConfidence: 0.8 }), turn({ turnId: 'b', saidConfidence: 0.8 })]

  const after = setVerdict(records, 'a', false)

  expect(after.find(one => one.turnId === 'a')?.landed).toBe(false)
  expect(after.find(one => one.turnId === 'b')?.landed).toBeUndefined()
})

test('undoing a verdict returns the turn to owed, win or skip alike', async () => {
  const landed = setVerdict([turn({ turnId: 'a', saidConfidence: 0.8 })], 'a', true)
  const backToOwed = undoVerdict(landed, 'a')

  expect(owedVerdict(backToOwed)?.turnId).toBe('a')
  expect(backToOwed[0]?.landed).toBeUndefined()

  const skipped = skipVerdict([turn({ turnId: 'b', saidConfidence: 0.8 })], 'b')
  expect(owedVerdict(undoVerdict(skipped, 'b'))?.turnId).toBe('b')

  // Undoing a turn that was never bet on is a no-op, not an error.
  const neverBet = [turn({ turnId: 'c' })]
  expect(undoVerdict(neverBet, 'c')).toEqual(neverBet)
})

test('the verdict asked for is the latest one owed', async () => {
  const records = [
    turn({ turnId: 'old', at: 100, saidConfidence: 0.8 }),
    turn({ turnId: 'new', at: 900, saidConfidence: 0.8 }),
    turn({ turnId: 'done', at: 950, saidConfidence: 0.8, landed: true }),
  ]

  expect(owedVerdict(records)?.turnId).toBe('new')
  // Once the latest is answered, the one behind it is next.
  expect(owedVerdict(setVerdict(records, 'new', true))?.turnId).toBe('old')
  expect(owedVerdict([turn()])).toBeUndefined()
})

test('a duration reads as seconds under a minute and minutes past it', async () => {
  expect(asDuration(4200)).toBe('4s')
  expect(asDuration(59000)).toBe('59s')
  expect(asDuration(60000)).toBe('1m 0s')
  expect(asDuration(125000)).toBe('2m 5s')
})

test('the report stands up with nothing in it, and names the numbers once there are', async () => {
  expect(asText(report([]))).toContain('No turns recorded yet')

  const text = asText(
    report([
      turn({ saidConfidence: 0.9, landed: false, saidFiles: '1', filesBucket: '4+' }),
      turn({ saidConfidence: 0.9, landed: false }),
      turn({ saidConfidence: 0.9, landed: false }),
      turn({ saidConfidence: 0.9, landed: false }),
      turn({ saidConfidence: 0.9, landed: false }),
    ]),
  )

  expect(text).toContain('Brier')
  expect(text).toContain('overconfident')
  // Columns line up under a heading, so a column of rows is scannable.
  expect(text).toContain('said     actual   turns')
  expect(text).toContain('90% →      0%')
  // The percentage and the raw count agree, rather than one surface showing
  // a fraction and another a percent for the same number.
  expect(text).toContain('The agent landed it first try 0% (0/5).')
})

test('the file count shows in the text report before any turn is scored', async () => {
  // A person who always skips the landed/fixed verdict still generates
  // file-count forecasts, and should still see that stat.
  const text = asText(report([turn({ saidFiles: '2-3', filesBucket: '2-3' })]))

  expect(text).toContain('none scored yet')
  expect(text).toContain('File count called right 1/1')
})

test('under five scored calls the report counts up instead of judging', async () => {
  const text = asText(
    report([turn({ saidConfidence: 0.9, landed: false }), turn({ saidConfidence: 0.9, landed: false })]),
  )

  // Two misses are not "90 points overconfident": too few to say which way you lean.
  expect(text).toStartWith('Calibrating: 2 of 5 calls scored.')
  expect(text).not.toContain('Brier')
  // What there is still shows, so the calls are not lost.
  expect(text).toContain('90% →      0%')
})

test('a waved-away verdict owes nothing and scores nothing', async () => {
  const records = skipVerdict([turn({ turnId: 'a', saidConfidence: 0.8 })], 'a')
  const found = report(records)

  expect(found.owed).toBe(0)
  expect(found.scored).toBe(0)
  // The turn still happened, so it stays on the record.
  expect(found.recorded).toBe(1)
})

test('a verdict owed past the window lapses, and nothing else does', async () => {
  const at = 10_000
  const records = [
    turn({ turnId: 'stale', at, saidConfidence: 0.8 }),
    turn({ turnId: 'fresh', at: at + VERDICT_WINDOW_MS, saidConfidence: 0.8 }),
    turn({ turnId: 'answered', at, saidConfidence: 0.8, landed: true }),
    turn({ turnId: 'unbet', at }),
  ]
  const now = at + VERDICT_WINDOW_MS + 1

  const kept = lapseVerdicts(records, now)

  // The stale one is waved away, so it is neither asked about nor scored.
  expect(owedVerdict(kept)?.turnId).toBe('fresh')
  expect(report(kept).owed).toBe(1)
  expect(report(kept).scored).toBe(1)
  // It still happened, so it stays on the record.
  expect(report(kept).recorded).toBe(4)
  expect(kept.find(one => one.turnId === 'answered')?.landed).toBe(true)
})

test('nothing lapsed hands the same records back, so nothing is written', async () => {
  const records = [turn({ turnId: 'fresh', at: 5000, saidConfidence: 0.8 })]

  expect(lapseVerdicts(records, 5000 + VERDICT_WINDOW_MS)).toBe(records)
  expect(lapseVerdicts([], 0)).toEqual([])
})

test('a waved-away verdict is not asked about again', async () => {
  const records = skipVerdict([turn({ turnId: 'a', saidConfidence: 0.8 })], 'a')

  expect(owedVerdict(records)).toBeUndefined()
})

test('the worst calls are the widest misses, and name what was asked', async () => {
  const misses = worstCalls([
    turn({ saidConfidence: 0.95, landed: false, ask: 'refactor the auth layer' }),
    turn({ saidConfidence: 0.8, landed: false, ask: 'rename a variable' }),
    turn({ saidConfidence: 0.9, landed: true, ask: 'add a test' }),
  ])

  expect(misses.map(one => one.ask)).toEqual(['refactor the auth layer', 'rename a variable'])
  expect(misses[0]?.error).toBeGreaterThan(misses[1]?.error ?? 1)
})

test('a call that was nearly right is not held up as a worst call', async () => {
  // 0.9 and it landed is an error of 0.01: being right is not a miss.
  expect(worstCalls([turn({ saidConfidence: 0.9, landed: true })])).toEqual([])
})

test('the headline says the lean in words before any score', async () => {
  const misses = (n: number) => Array.from({ length: n }, () => turn({ saidConfidence: 0.9, landed: false }))

  expect(headline(report(misses(5)))).toBe('You run 90 points overconfident.')
  const even = [true, false, true, false, true, false].map(landed => turn({ saidConfidence: 0.5, landed }))
  expect(headline(report(even))).toBe('Your forecasts match what happens.')
  // Below five it says how far along the sample is, not which way it leans.
  expect(headline(report(misses(4)))).toBe('Calibrating: 4 of 5 calls scored.')
})

test('an ask is flattened to one line and cut to the room there is', async () => {
  expect(shortAsk('  add   the\n retry logic ')).toBe('add the retry logic')
  expect(shortAsk('a'.repeat(80)).length).toBe(48)
  expect(shortAsk('a'.repeat(80)).endsWith('…')).toBe(true)
  expect(shortAsk('short enough', 20)).toBe('short enough')
  expect(shortAsk('anything', 0)).toBe('')
})

test('a cut landing inside a surrogate pair drops the whole character, not half of it', async () => {
  // With the default room (48), the cut falls at index 47: 46 plain
  // characters put the emoji's high surrogate exactly there, so a naive
  // slice would keep it alone, a broken half-character ahead of the ellipsis.
  const splitAtEmoji = `${'a'.repeat(46)}😀${'b'.repeat(20)}`

  expect(shortAsk(splitAtEmoji)).toBe(`${'a'.repeat(46)}…`)
})

test('a surrogate pair that lands clear of the cut survives it whole', async () => {
  // One character earlier: the cut now falls just past the emoji's low
  // surrogate, so the whole pair is kept rather than dropped.
  const wellInside = `${'a'.repeat(45)}😀${'b'.repeat(20)}`

  expect(shortAsk(wellInside)).toBe(`${'a'.repeat(45)}😀…`)
})

test('the question line quotes as much of the ask as its own words leave room for', async () => {
  expect(askRoomFor(200)).toBe(64)
  expect(askRoomFor(80)).toBe(48)
  // Beside a docked pane the band is narrow, and still quotes something useful.
  expect(askRoomFor(50)).toBe(18)
  // Under a dozen characters a quote says nothing, so it is dropped.
  expect(askRoomFor(43)).toBe(0)
  // The verdict line has more words of its own, so its quote gets less room.
  expect(askRoomFor(80, VERDICT_CHROME)).toBe(42)
})

test('the report names the worst calls once there are any', async () => {
  const text = asText(
    report([
      turn({ saidConfidence: 0.95, landed: false, ask: 'refactor the auth layer' }),
      turn({ saidConfidence: 0.95, landed: false, ask: 'rename a thing' }),
      turn({ saidConfidence: 0.95, landed: false, ask: 'rename a thing' }),
      turn({ saidConfidence: 0.95, landed: false, ask: 'add a cache' }),
      turn({ saidConfidence: 0.95, landed: false, ask: 'add a cache' }),
    ]),
  )

  expect(text).toStartWith('You run 95 points overconfident.')
  expect(text).toContain('Worst calls')
  expect(text).toContain('refactor the auth layer')
  // The same ask missed twice is one line marked twice, not the line again.
  expect(text).toContain('and it did not (×2) — rename a thing')
  expect(text.split('rename a thing').length - 1).toBe(1)
})

test('file buckets read as words where a digit would mislead', async () => {
  // Pressed by digit: "1: 0  2: 1" put "one file" on the 2 key.
  expect(FILE_LABELS['0']).toBe('none')
  expect(FILE_LABELS['1']).toBe('one')
  expect(filesPhrase('2-3')).toBe('2–3 files')
  expect(filesPhrase('1')).toBe('1 file')
  expect(filesPhrase('0')).toBe('no files')
})

test('a calibration row pads to the width of its heading', async () => {
  const line = calibrationLine({ said: 0.8, actual: 0.64, turns: 11, lean: 'over' })

  expect(line).toContain('80%')
  expect(line).toContain('64%')
  expect(line).toContain('overconfident')
  // The heading and the row are the same shape, so the columns agree.
  expect(line.indexOf('%')).toBeLessThan(CALIBRATION_HEAD.indexOf('actual'))
})

test('a row that is honest says nothing about leaning', async () => {
  const line = calibrationLine({ said: 0.5, actual: 0.5, turns: 4, lean: 'fair' })

  expect(line).not.toContain('confident')
})
