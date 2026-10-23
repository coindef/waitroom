import { expect, test } from 'claude-code/testing'

import type { DailyChallengeRecord, TurnRecord } from '../types'
import {
  asDuration,
  askRoomFor,
  badges,
  BONUS_HUNTER_TARGET,
  calibrationLine,
  CALIBRATION_HEAD,
  asText,
  bonusBucketOf,
  bonusDimFor,
  bonusLabel,
  bucketOf,
  calibration,
  challengeFor,
  challengeQuestion,
  challengeThreshold,
  changedSince,
  CHALLENGE_QUESTIONS,
  CHALLENGE_QUESTIONS_FALLBACK,
  COIN_FLIP_BRIER,
  currentRank,
  currentStreak,
  dailyChallengeDimFor,
  dailyChallengeStreak,
  dailyChallengeValue,
  dailyOutcome,
  extremeCalls,
  FALLBACK_MEDIAN,
  FILE_LABELS,
  filesPhrase,
  hasChallengeHistory,
  headline,
  HOT_STREAK_TARGET,
  keepDailyChallenge,
  keepRecord,
  lapseVerdicts,
  localDateKey,
  median,
  owedVerdict,
  parseStatus,
  rankImproved,
  rankOf,
  recapCard,
  recapOf,
  REGULAR_TARGET,
  report,
  rollingBrier,
  setVerdict,
  SHARPSHOOTER_WINDOW,
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
    toolCalls: 0,
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

test('the bonus dimension rotates in a fixed order, wrapping after three', async () => {
  expect(bonusDimFor(0)).toBe('duration')
  expect(bonusDimFor(1)).toBe('files')
  expect(bonusDimFor(2)).toBe('toolCalls')
  expect(bonusDimFor(3)).toBe('duration')
  expect(bonusDimFor(5)).toBe('toolCalls')
})

test('the duration bonus splits at 30s and 90s', async () => {
  expect(bonusBucketOf('duration', 29999)).toBe('<30s')
  expect(bonusBucketOf('duration', 30000)).toBe('30-90s')
  expect(bonusBucketOf('duration', 90000)).toBe('30-90s')
  expect(bonusBucketOf('duration', 90001)).toBe('>90s')
})

test('the files bonus splits at 1 and 3, folding no files into the "1" bucket', async () => {
  expect(bonusBucketOf('files', 0)).toBe('1')
  expect(bonusBucketOf('files', 1)).toBe('1')
  expect(bonusBucketOf('files', 2)).toBe('2-3')
  expect(bonusBucketOf('files', 3)).toBe('2-3')
  expect(bonusBucketOf('files', 4)).toBe('4+')
})

test('the tool-call bonus splits at 2 and 6', async () => {
  expect(bonusBucketOf('toolCalls', 0)).toBe('0-2')
  expect(bonusBucketOf('toolCalls', 2)).toBe('0-2')
  expect(bonusBucketOf('toolCalls', 3)).toBe('3-6')
  expect(bonusBucketOf('toolCalls', 6)).toBe('3-6')
  expect(bonusBucketOf('toolCalls', 7)).toBe('7+')
})

test('a bonus bucket is a word where a bare digit would read as a key, else itself', async () => {
  expect(bonusLabel('files', '1')).toBe('one')
  expect(bonusLabel('files', '2-3')).toBe('2–3')
  expect(bonusLabel('duration', '<30s')).toBe('<30s')
  expect(bonusLabel('toolCalls', '0-2')).toBe('0-2')
})

test('the bonus question is scored on whichever dimension it actually asked', async () => {
  const found = report([
    turn({ saidBonus: '<30s', bonusActual: '<30s', bonusDim: 'duration' }),
    turn({ saidBonus: '2-3', bonusActual: '4+', bonusDim: 'files' }),
    turn(),
  ])

  expect(found.bonus).toEqual({ right: 1, of: 2 })
})

test('an aborted turn’s bonus guess is recorded but never scored', async () => {
  const found = report([
    turn({ saidBonus: '<30s', bonusActual: '<30s', isAborted: true }),
    turn({ saidBonus: '<30s', bonusActual: '>90s' }),
  ])

  expect(found.bonus).toEqual({ right: 0, of: 1 })
})

test('the rank is Unranked under five scored turns, whatever the brier', async () => {
  expect(rankOf(0.01, 4)).toBe('Unranked')
  expect(rankOf(undefined, 20)).toBe('Unranked')
})

test('the rank cutoffs land exactly where the thresholds say, worst to best', async () => {
  expect(rankOf(0.3, 5)).toBe('Coin-Flipper')
  expect(rankOf(0.29, 5)).toBe('Bronze')
  expect(rankOf(0.25, 5)).toBe('Bronze')
  expect(rankOf(0.24, 5)).toBe('Silver')
  expect(rankOf(0.2, 5)).toBe('Silver')
  expect(rankOf(0.19, 5)).toBe('Gold')
  expect(rankOf(0.15, 5)).toBe('Gold')
  expect(rankOf(0.14, 5)).toBe('Platinum')
  expect(rankOf(0.1, 5)).toBe('Platinum')
  expect(rankOf(0.09, 5)).toBe('Oracle')
  expect(rankOf(0, 5)).toBe('Oracle')
})

test('a rank improves only on a climb, never on a hold or a fall', async () => {
  expect(rankImproved('Silver', 'Gold')).toBe(true)
  expect(rankImproved('Gold', 'Silver')).toBe(false)
  expect(rankImproved('Gold', 'Gold')).toBe(false)
  expect(rankImproved('Unranked', 'Coin-Flipper')).toBe(true)
})

test('the rolling Brier looks back only the window, aging the oldest calls out', async () => {
  const good = Array.from({ length: 20 }, () => turn({ saidConfidence: 0.9, landed: true }))
  const bad = Array.from({ length: 5 }, () => turn({ saidConfidence: 0.9, landed: false }))

  const { brier, scored } = rollingBrier([...good, ...bad])

  // The window holds the last 20: 15 surviving good calls plus all 5 bad.
  expect(scored).toBe(20)
  expect(brier?.toFixed(2)).toBe('0.21')
})

test('fewer than a window of scored turns uses what there is, and none at all is undefined', async () => {
  const one = rollingBrier([turn({ saidConfidence: 1, landed: true })])
  expect(one.scored).toBe(1)
  expect(one.brier).toBe(0)
  expect(rollingBrier([]).scored).toBe(0)
  expect(rollingBrier([]).brier).toBeUndefined()
})

test('the current rank reads the rolling Brier, not the lifetime one', async () => {
  const good = Array.from({ length: 20 }, () => turn({ saidConfidence: 0.9, landed: true }))
  const bad = Array.from({ length: 5 }, () => turn({ saidConfidence: 0.9, landed: false }))

  expect(currentRank([...good, ...bad])).toBe('Silver')
  expect(currentRank([])).toBe('Unranked')
})

test('the best and worst calls are the smallest and largest errors, not thresholded', async () => {
  const { best, worst } = extremeCalls([
    turn({ saidConfidence: 0.9, landed: true, ask: 'tiny miss' }),
    turn({ saidConfidence: 0.6, landed: false, ask: 'biggest miss' }),
    turn({ saidConfidence: 0.55, landed: true, ask: 'small miss' }),
  ])

  expect(best?.ask).toBe('tiny miss')
  expect(worst?.ask).toBe('biggest miss')
})

test('with nothing scored, there is no best or worst call', async () => {
  expect(extremeCalls([])).toEqual({})
})

test('the current streak counts consecutive landed calls back from the most recent', async () => {
  expect(
    currentStreak([
      turn({ saidConfidence: 0.8, landed: false }),
      turn({ saidConfidence: 0.8, landed: true }),
      turn({ saidConfidence: 0.8, landed: true }),
      turn({ saidConfidence: 0.8, landed: true }),
    ]),
  ).toBe(3)
})

test('a miss at the end breaks the streak back to zero, whatever came before', async () => {
  expect(
    currentStreak([
      turn({ saidConfidence: 0.8, landed: true }),
      turn({ saidConfidence: 0.8, landed: true }),
      turn({ saidConfidence: 0.8, landed: false }),
    ]),
  ).toBe(0)
  expect(currentStreak([])).toBe(0)
})

test('a rank climb prints one celebratory line in the report', async () => {
  const found = report(Array.from({ length: 5 }, () => turn({ saidConfidence: 0.9, landed: true })))

  expect(asText(found, { from: 'Silver', to: 'Gold' })).toContain('Rank up: Silver -> Gold')
  expect(asText(found)).not.toContain('Rank up')
})

test('the report always names the current rank, even while still calibrating', async () => {
  expect(asText(report([turn({ saidConfidence: 0.9, landed: true })]))).toContain('Rank: Unranked.')
})

test('the bonus line in the text report shows once a bonus question is answered, scored or not', async () => {
  const beforeScoring = asText(report([turn({ saidBonus: '<30s', bonusActual: '<30s' })]))
  expect(beforeScoring).toContain('none scored yet')
  expect(beforeScoring).toContain('Bonus: 1/1 correct')

  // The Bonus Hunter badge still names itself in the wall below (locked or
  // not); the stat line is what a turn with no bonus answer must not add.
  expect(asText(report([turn()]))).not.toContain('Bonus:')
})

test('the recap scopes its totals to the session, but the rank to the whole history', async () => {
  const sessionTurns = [
    turn({ saidConfidence: 0.9, landed: true, saidBonus: '<30s', bonusActual: '<30s' }),
  ]
  const all = [...Array.from({ length: 4 }, () => turn({ saidConfidence: 0.9, landed: true })), ...sessionTurns]

  const recap = recapOf(sessionTurns, all, [], '2024-01-01')

  expect(recap.turnsBet).toBe(1)
  expect(recap.turnsScored).toBe(1)
  expect(recap.bonus).toEqual({ right: 1, of: 1 })
  expect(recap.streak).toBe(1)
  // Five scored turns across the whole history, all landed: not Unranked.
  expect(recap.rank).not.toBe('Unranked')
  // The badge wall reads the whole history, not the session alone.
  expect(recap.badges).toHaveLength(6)
})

test('a session with nothing scored still produces a complete, if empty, recap', async () => {
  const recap = recapOf([], [], [], '2024-01-01')

  expect(recap.turnsBet).toBe(0)
  expect(recap.turnsScored).toBe(0)
  expect(recap.brier).toBeUndefined()
  expect(recap.best).toBeUndefined()
  expect(recap.worst).toBeUndefined()
  expect(recap.rank).toBe('Unranked')
  expect(recap.streak).toBe(0)
  expect(recap.bonus).toBeUndefined()
  expect(recap.badges.every(one => !one.earned)).toBe(true)
  expect(recap.dailyChallenge).toBe('—')
})

test('the recap card is a box-drawn, plain-text summary with every field on its own row', async () => {
  const card = recapCard({
    turnsBet: 7,
    turnsScored: 5,
    brier: 0.147,
    best: { said: 0.95, landed: true, error: 0.0025, ask: 'add retry' },
    worst: { said: 0.9, landed: false, error: 0.81, ask: 'refactor auth' },
    rank: 'Gold',
    streak: 3,
    bonus: { right: 3, of: 5 },
    dailyChallenge: '3-day streak',
    badges: [
      { id: 'firstSteps', name: 'First Steps', earned: true },
      { id: 'hotStreak', name: 'Hot Streak', earned: false, progress: { have: 3, of: 5 } },
    ],
  })

  expect(card).toContain('Session recap')
  expect(card).toContain('Turns bet')
  expect(card).toContain('0.147')
  expect(card).toContain('Gold')
  expect(card).toContain('add retry')
  expect(card).toContain('refactor auth')
  expect(card).toContain('3/5 correct')
  expect(card).toContain('3-day streak')
  expect(card).toContain('Badges')
  expect(card).toContain('First Steps')
  expect(card).toContain('Hot Streak')
  expect(card).toContain('3/5')
  // Copy-paste friendly: no ANSI escapes hiding inside the box.
  expect(card).not.toMatch(/\u001b/)
  expect(card.startsWith('┌')).toBe(true)
  expect(card.endsWith('┘')).toBe(true)
  // Every row, border included, is the same length: a box that draws straight.
  const widths = new Set(card.split('\n').map(line => line.length))
  expect(widths.size).toBe(1)
})

test('a thin recap still draws a complete card, an em dash standing in for what has not happened yet', async () => {
  const card = recapCard({ turnsBet: 0, turnsScored: 0, rank: 'Unranked', streak: 0, badges: badges([]), dailyChallenge: '—' })

  expect(card).toContain('Session recap')
  expect(card).toContain('—')
  const widths = new Set(card.split('\n').map(line => line.length))
  expect(widths.size).toBe(1)
})

const landed = (count: number) => Array.from({ length: count }, () => turn({ saidConfidence: 0.9, landed: true }))
const missed = (count: number) => Array.from({ length: count }, () => turn({ saidConfidence: 0.9, landed: false }))

test('with no history, every badge is locked and the wall never changes shape', async () => {
  const wall = badges([])

  expect(wall).toHaveLength(6)
  expect(wall.every(one => !one.earned)).toBe(true)
  expect(wall.find(one => one.id === 'firstSteps')?.progress).toBeUndefined()
  expect(wall.find(one => one.id === 'hotStreak')?.progress).toEqual({ have: 0, of: 5 })
})

test('First Steps earns on the first scored bet, not merely a recorded one', async () => {
  expect(badges([turn({ saidConfidence: 0.8 })]).find(one => one.id === 'firstSteps')?.earned).toBe(false)
  expect(
    badges([turn({ saidConfidence: 0.8, landed: true })]).find(one => one.id === 'firstSteps')?.earned,
  ).toBe(true)
})

test('report carries the same badge wall the recap card does, so /bet is never the surface left behind', async () => {
  const empty = report([])
  expect(empty.badges).toEqual(badges([]))

  const scored = report([turn({ saidConfidence: 0.8, landed: true })])
  expect(scored.badges.find(one => one.id === 'firstSteps')?.earned).toBe(true)
})

test('asText prints the badge wall beside the record, earned or locked, whether or not anything is scored yet', async () => {
  const unscored = asText(report([turn({ saidConfidence: 0.8 })]))
  expect(unscored).toContain('none scored yet')
  expect(unscored).toContain('Badges')
  expect(unscored).toContain('— First Steps')

  const scored = asText(report([turn({ saidConfidence: 0.8, landed: true })]))
  expect(scored).toContain('Badges')
  expect(scored).toContain('✓ First Steps')
})

test('Hot Streak earns on five consecutive landed calls anywhere in history, not only the most recent', async () => {
  // The streak of five sits in the middle, broken by a miss, then two more landed.
  const history = [...landed(5), ...missed(1), ...landed(2)]

  const hotStreak = badges(history).find(one => one.id === 'hotStreak')
  expect(hotStreak?.earned).toBe(true)
  expect(hotStreak?.progress).toBeUndefined()
})

test('four consecutive landed calls is Hot Streak locked, one short', async () => {
  const hotStreak = badges(landed(4)).find(one => one.id === 'hotStreak')

  expect(hotStreak?.earned).toBe(false)
  expect(hotStreak?.progress).toEqual({ have: 4, of: 5 })
})

test('Sharpshooter earns the moment any ten consecutive scored calls beat a 0.20 Brier', async () => {
  const sharp = badges(landed(10)).find(one => one.id === 'sharpshooter')

  expect(sharp?.earned).toBe(true)
})

test('Sharpshooter is not earned exactly at the 0.20 boundary, only strictly under it', async () => {
  // Eight landed at 60% (error 0.16) and two missed at 60% (error 0.36): a
  // mean Brier of exactly 0.20 over the ten.
  const exactlyAtBoundary = [
    ...Array.from({ length: 8 }, () => turn({ saidConfidence: 0.6, landed: true })),
    ...Array.from({ length: 2 }, () => turn({ saidConfidence: 0.6, landed: false })),
  ]

  expect(badges(exactlyAtBoundary).find(one => one.id === 'sharpshooter')?.earned).toBe(false)
  expect(badges(exactlyAtBoundary).find(one => one.id === 'sharpshooter')?.progress).toEqual({ have: 10, of: 10 })
})

test('Sharpshooter stays locked on nine scored calls, however good they are', async () => {
  const sharp = badges(landed(9)).find(one => one.id === 'sharpshooter')

  expect(sharp?.earned).toBe(false)
  expect(sharp?.progress).toEqual({ have: 9, of: 10 })
})

test('Oracle Path earns by reaching the rank at least once, read off history the way it stood at the time', async () => {
  // Five turns at 98%, all landed: a 0.0004 Brier, five scored - Oracle at that point.
  const greatRun = Array.from({ length: 5 }, () => turn({ saidConfidence: 0.98, landed: true }))

  expect(badges(greatRun).find(one => one.id === 'oraclePath')?.earned).toBe(true)
})

test('Oracle Path stays earned even after the rank falls back since', async () => {
  const greatRun = Array.from({ length: 5 }, () => turn({ saidConfidence: 0.98, landed: true }))
  const badRun = missed(5)
  const history = [...greatRun, ...badRun]

  // The rank right now has fallen well off Oracle, but the badge does not revoke.
  expect(currentRank(history)).not.toBe('Oracle')
  expect(badges(history).find(one => one.id === 'oraclePath')?.earned).toBe(true)
})

test('Oracle Path stays locked under five scored turns, however good they are', async () => {
  const almost = Array.from({ length: 4 }, () => turn({ saidConfidence: 0.98, landed: true }))

  expect(badges(almost).find(one => one.id === 'oraclePath')?.earned).toBe(false)
})

test('Bonus Hunter earns on five correct bonus answers, lifetime', async () => {
  const bonusHit = (n: number) =>
    Array.from({ length: n }, () => turn({ saidBonus: '<30s', bonusActual: '<30s' }))

  expect(badges(bonusHit(5)).find(one => one.id === 'bonusHunter')?.earned).toBe(true)
  const four = badges(bonusHit(4)).find(one => one.id === 'bonusHunter')
  expect(four?.earned).toBe(false)
  expect(four?.progress).toEqual({ have: 4, of: 5 })
})

test('an aborted turn’s bonus guess never counts toward Bonus Hunter', async () => {
  const abortedHits = Array.from({ length: 5 }, () =>
    turn({ saidBonus: '<30s', bonusActual: '<30s', isAborted: true }),
  )

  expect(badges(abortedHits).find(one => one.id === 'bonusHunter')?.earned).toBe(false)
})

test('Regular earns on five distinct days with a scored bet', async () => {
  const dayOf = (day: number) => new Date(2024, 0, day).getTime()
  const fiveDays = Array.from({ length: 5 }, (_, at) =>
    turn({ at: dayOf(at + 1), saidConfidence: 0.8, landed: true }),
  )

  expect(badges(fiveDays).find(one => one.id === 'regular')?.earned).toBe(true)
})

test('two scored bets on the same day count as one day toward Regular', async () => {
  const sameDay = new Date(2024, 0, 1).getTime()
  const history = [
    turn({ at: sameDay, saidConfidence: 0.8, landed: true }),
    turn({ at: sameDay + 1000, saidConfidence: 0.8, landed: true }),
    turn({ at: new Date(2024, 0, 2).getTime(), saidConfidence: 0.8, landed: true }),
  ]

  const regular = badges(history).find(one => one.id === 'regular')
  expect(regular?.earned).toBe(false)
  expect(regular?.progress).toEqual({ have: 2, of: 5 })
})

test('the daily challenge dimension is deterministic from the date alone', async () => {
  expect(dailyChallengeDimFor('2024-03-01')).toBe(dailyChallengeDimFor('2024-03-01'))
  expect(dailyChallengeDimFor('2024-03-01')).toBe(dailyChallengeDimFor('2024-03-01'))
})

test('the daily challenge dimension varies across dates, rather than always landing the same', async () => {
  const dims = new Set(
    Array.from({ length: 12 }, (_, at) => dailyChallengeDimFor(`2024-01-${String(at + 1).padStart(2, '0')}`)),
  )

  // Not every date need differ, but a dozen consecutive days should not all collapse to one.
  expect(dims.size).toBeGreaterThan(1)
})

test('the daily challenge dimension does not fall into an obvious day-to-day rotation', async () => {
  // A whole month of consecutive dates differs in only its last digit or
  // two, almost every day — exactly the shape that used to put every third
  // day on the same dimension, for as long as the month ran.
  const dims = Array.from({ length: 28 }, (_, at) =>
    dailyChallengeDimFor(`2024-02-${String(at + 1).padStart(2, '0')}`),
  )
  const matchesThreeAgo = dims.filter((dim, at) => at >= 3 && dim === dims[at - 3]).length

  // Not every third day need differ, but a fixed 3-day rotation would make
  // every single one match; this is a spot check that is far looser than that.
  expect(matchesThreeAgo).toBeLessThan(dims.length - 3)
})

test('the challenge threshold falls back to a fixed number before there is enough history', async () => {
  expect(challengeThreshold([], 'files')).toBe(FALLBACK_MEDIAN.files)
  const thin = Array.from({ length: 4 }, () => turn({ saidConfidence: 0.8, landed: true, files: 10 }))
  expect(challengeThreshold(thin, 'files')).toBe(FALLBACK_MEDIAN.files)
})

test('the challenge threshold reads the person’s own median once there is enough history', async () => {
  const history = [1, 2, 3, 4, 5].map(files => turn({ saidConfidence: 0.8, landed: true, files }))

  expect(challengeThreshold(history, 'files')).toBe(3)
})

test('hasChallengeHistory is challengeThreshold’s own condition, exposed so the question’s wording can match it', async () => {
  expect(hasChallengeHistory([])).toBe(false)
  const thin = Array.from({ length: 4 }, () => turn({ saidConfidence: 0.8, landed: true, files: 10 }))
  expect(hasChallengeHistory(thin)).toBe(false)
  const enough = Array.from({ length: 5 }, () => turn({ saidConfidence: 0.8, landed: true, files: 10 }))
  expect(hasChallengeHistory(enough)).toBe(true)
})

test('the challenge question does not claim a personal median before there is enough history for one', async () => {
  expect(challengeQuestion([], 'files')).toBe(CHALLENGE_QUESTIONS_FALLBACK.files)
  expect(challengeQuestion([], 'duration')).toBe(CHALLENGE_QUESTIONS_FALLBACK.duration)
  expect(challengeQuestion([], 'toolCalls')).toBe(CHALLENGE_QUESTIONS_FALLBACK.toolCalls)
  expect(CHALLENGE_QUESTIONS_FALLBACK.files).not.toMatch(/median/)

  const history = Array.from({ length: 5 }, () => turn({ saidConfidence: 0.8, landed: true, files: 2 }))
  expect(challengeQuestion(history, 'files')).toBe(CHALLENGE_QUESTIONS.files)
  expect(CHALLENGE_QUESTIONS.files).toMatch(/median/)
})

test('the daily outcome is "yes" only strictly past the threshold, not merely at it', async () => {
  expect(dailyOutcome(5, 3)).toBe('yes')
  expect(dailyOutcome(3, 3)).toBe('no')
  expect(dailyOutcome(1, 3)).toBe('no')
})

test('a daily-challenge record is kept once a day, the newest write winning', async () => {
  const first = keepDailyChallenge([], { date: '2024-01-01', dim: 'files', guess: 'yes', actual: 'no', correct: false })
  const again = keepDailyChallenge(first, {
    date: '2024-01-01',
    dim: 'files',
    guess: 'yes',
    actual: 'yes',
    correct: true,
  })

  expect(again).toHaveLength(1)
  expect(again[0]?.correct).toBe(true)
})

test('challengeFor finds a day’s record, answered or skipped alike, or nothing for a day never offered', async () => {
  const log: DailyChallengeRecord[] = [
    { date: '2024-01-01', dim: 'files', guess: 'yes', actual: 'yes', correct: true },
    { date: '2024-01-02', dim: 'duration', isSkipped: true },
  ]

  expect(challengeFor(log, '2024-01-01')?.correct).toBe(true)
  expect(challengeFor(log, '2024-01-02')?.isSkipped).toBe(true)
  expect(challengeFor(log, '2024-01-03')).toBeUndefined()
})

test('the streak counts back consecutive right days, broken by a wrong or skipped one', async () => {
  const right = (date: string): DailyChallengeRecord => ({ date, dim: 'files', guess: 'yes', actual: 'yes', correct: true })
  const wrong = (date: string): DailyChallengeRecord => ({ date, dim: 'files', guess: 'yes', actual: 'no', correct: false })

  expect(dailyChallengeStreak([right('d1'), right('d2'), right('d3')])).toBe(3)
  expect(dailyChallengeStreak([right('d1'), wrong('d2'), right('d3')])).toBe(1)
  expect(dailyChallengeStreak([wrong('d1')])).toBe(0)
  expect(dailyChallengeStreak([])).toBe(0)
  // A day skipped, rather than missed, still breaks the run just the same.
  expect(dailyChallengeStreak([right('d1'), { date: 'd2', dim: 'files', isSkipped: true }])).toBe(0)
  // A day offered but never touched is neither a hit nor a miss: it does not
  // extend the streak, but unlike a skip, it does not break it either.
  expect(
    dailyChallengeStreak([right('d1'), right('d2'), { date: 'd3', dim: 'files', isNotTaken: true }]),
  ).toBe(2)
  expect(dailyChallengeStreak([{ date: 'd1', dim: 'files', isNotTaken: true }])).toBe(0)
})

test('the recap value is the streak once it is worth naming, else today’s own result', async () => {
  const right = (date: string): DailyChallengeRecord => ({ date, dim: 'files', guess: 'yes', actual: 'yes', correct: true })
  const wrong = (date: string): DailyChallengeRecord => ({ date, dim: 'files', guess: 'yes', actual: 'no', correct: false })

  expect(dailyChallengeValue([right('d1'), right('d2'), right('d3')], 'd3')).toBe('3-day streak')
  // Only today, and it was right: one data point does not read as a "streak".
  expect(dailyChallengeValue([right('d1')], 'd1')).toBe('right today')
  expect(dailyChallengeValue([wrong('d1')], 'd1')).toBe('missed today')
  expect(dailyChallengeValue([{ date: 'd1', dim: 'files', isSkipped: true }], 'd1')).toBe('skipped today')
  // Offered and left untouched reads distinctly from a day with no turns at
  // all, which stays a plain em dash.
  expect(dailyChallengeValue([{ date: 'd1', dim: 'files', isNotTaken: true }], 'd1')).toBe('not taken')
  expect(dailyChallengeValue([], 'd1')).toBe('—')
})
