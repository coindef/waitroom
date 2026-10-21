/**
 * Scoring: no engine, no $, so `claude plugin test` exercises it directly.
 *
 * The scoring rule is the Brier score, mean squared error of a forecast against
 * what happened. It is proper: you cannot improve it by shading your answer
 * away from what you actually believe, which is the whole point of scoring
 * calibration rather than counting wins.
 */

import type {
  BonusBucket,
  BonusDim,
  DailyChallengeRecord,
  DailyGuess,
  Rank,
  RankChange,
  FileBucket,
  TurnRecord,
} from '../types'

/** The forecasts on offer. Fixed, so each is its own calibration row. */
export const BANDS = [0.5, 0.65, 0.8, 0.9, 0.95] as const

export const FILE_BUCKETS: readonly FileBucket[] = ['0', '1', '2-3', '4+']

/** Always saying 50% scores this, so a score at or above it beats no skill. */
export const COIN_FLIP_BRIER = 0.25

/** Where a count of written files falls among the buckets. */
export const bucketOf = (files: number): FileBucket => {
  if (files <= 0) return '0'
  if (files === 1) return '1'

  return files <= 3 ? '2-3' : '4+'
}

/**
 * The bonus question, one dimension beside land/fail: a turn offers exactly
 * one, rotating through these in order, so no one dimension crowds out the
 * others over a long session.
 */
export const BONUS_DIMS: readonly BonusDim[] = ['duration', 'files', 'toolCalls']

/** Which dimension a turn's bonus question is, from how many have been offered so far. */
export const bonusDimFor = (offered: number): BonusDim => {
  const at = BONUS_DIMS[offered % BONUS_DIMS.length]

  return at ?? 'duration'
}

/** The buckets on offer for each bonus dimension, in the order its buttons show them. */
export const BONUS_BUCKETS: Readonly<Record<BonusDim, readonly BonusBucket[]>> = {
  duration: ['<30s', '30-90s', '>90s'],
  files: ['1', '2-3', '4+'],
  toolCalls: ['0-2', '3-6', '7+'],
}

/** What the bonus question asks, per dimension. */
export const BONUS_QUESTIONS: Readonly<Record<BonusDim, string>> = {
  duration: 'how long will this turn take?',
  files: 'how many files will it touch?',
  toolCalls: 'how many tool calls will it make?',
}

/**
 * Where a turn's actual duration, file count or tool-call count falls among
 * its dimension's three buckets.
 *
 * One function covers all three because each is the same shape — a count
 * split at two cutoffs — and a turn's bonus answer is scored against whichever
 * of them its rotation offered.
 */
export const bonusBucketOf = (dim: BonusDim, value: number): BonusBucket => {
  if (dim === 'duration') {
    const seconds = value / 1000
    if (seconds < 30) return '<30s'

    return seconds <= 90 ? '30-90s' : '>90s'
  }
  if (dim === 'files') {
    if (value <= 1) return '1'

    return value <= 3 ? '2-3' : '4+'
  }
  if (value <= 2) return '0-2'

  return value <= 6 ? '3-6' : '7+'
}

/**
 * A bonus bucket as a button label.
 *
 * The files dimension reuses `FILE_LABELS` so "1 file" never sits on the same
 * key as the digit 1 — the bug the main files bet already had to fix. The
 * other two dimensions' labels are not bare digits, so they are fine as is.
 */
export const bonusLabel = (dim: BonusDim, bucket: BonusBucket): string =>
  dim === 'files' ? FILE_LABELS[bucket as FileBucket] : bucket

/**
 * The daily challenge's own dimension pool: the same three stats the bonus
 * question rotates through, asked a different way — not "which bucket" but
 * "more or less than usual" — so today's question needs no fact the plugin
 * was not already recording.
 */
export const DAILY_CHALLENGE_DIMS: readonly BonusDim[] = ['files', 'duration', 'toolCalls']

/**
 * A small, stable hash of a string into `0` .. `mod - 1`.
 *
 * Deterministic across runs and processes, unlike `Math.random`, so the same
 * calendar date always lands on the same challenge.
 *
 * The rolling sum alone is linear in its input, and two calendar dates in a
 * row differ by one trailing character almost always — so a plain `% mod`
 * off it rotated through the dimensions in lockstep, `mod`-ish days at a
 * time. Murmur3's finalizer, run over the rolling sum, scrambles that
 * structure out before the final mod.
 */
const seededIndex = (key: string, mod: number): number => {
  let hash = 0
  for (let at = 0; at < key.length; at++) hash = (Math.imul(hash, 31) + key.charCodeAt(at)) >>> 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0
  hash = (hash ^ (hash >>> 16)) >>> 0

  return hash % mod
}

/**
 * The local calendar day a timestamp falls on, `YYYY-MM-DD` — the daily
 * challenge's seed and the Regular badge's own unit of "a day".
 */
export const localDateKey = (ms: number): string => {
  const at = new Date(ms)
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/** Which dimension today's challenge asks about — the same all day, from the date alone. */
export const dailyChallengeDimFor = (dateKey: string): BonusDim =>
  DAILY_CHALLENGE_DIMS[seededIndex(dateKey, DAILY_CHALLENGE_DIMS.length)] ?? 'files'

/**
 * The threshold the daily challenge is judged against before there is enough
 * history to use the person's own median instead — the same rough middle
 * each of the bonus question's own buckets straddles.
 */
export const FALLBACK_MEDIAN: Readonly<Record<BonusDim, number>> = {
  duration: 60000,
  files: 2,
  toolCalls: 4,
}

/** Whether there is enough scored history to judge the daily challenge against the person's own median, rather than the fixed fallback. */
export const hasChallengeHistory = (records: readonly TurnRecord[]): boolean => scorable(records).length >= MIN_SCORED

/**
 * What a turn's forecast is measured against: the person's own median once
 * there is enough history to trust it, else a fixed stand-in.
 */
export const challengeThreshold = (records: readonly TurnRecord[], dim: BonusDim): number => {
  if (!hasChallengeHistory(records)) return FALLBACK_MEDIAN[dim]
  const live = records.filter(one => !one.isAborted)
  const values =
    dim === 'duration'
      ? live.map(one => one.durationMs)
      : dim === 'files'
        ? live.map(one => one.files)
        : live.map(one => one.toolCalls)

  return median(values) ?? FALLBACK_MEDIAN[dim]
}

/** What the daily challenge asks, per dimension, once there is enough history for "median" to mean the person's own. */
export const CHALLENGE_QUESTIONS: Readonly<Record<BonusDim, string>> = {
  duration: 'take longer than your median?',
  files: 'touch more files than your median?',
  toolCalls: 'use more tool calls than your median?',
}

/**
 * The same questions, worded for someone `challengeThreshold` has not yet
 * seen enough history from: it judges the turn against `FALLBACK_MEDIAN`
 * then, so the question should not claim a personal median it is not using.
 */
export const CHALLENGE_QUESTIONS_FALLBACK: Readonly<Record<BonusDim, string>> = {
  duration: 'take longer than a typical turn?',
  files: 'touch more files than a typical turn?',
  toolCalls: 'use more tool calls than a typical turn?',
}

/** Which wording the daily challenge asks with — `challengeThreshold`'s own condition decides, so the two can never drift apart. */
export const challengeQuestion = (records: readonly TurnRecord[], dim: BonusDim): string =>
  (hasChallengeHistory(records) ? CHALLENGE_QUESTIONS : CHALLENGE_QUESTIONS_FALLBACK)[dim]

/** Where a turn's actual value for a challenge dimension falls against the threshold it was offered. */
export const dailyOutcome = (value: number, threshold: number): DailyGuess => (value > threshold ? 'yes' : 'no')

/** Adds or replaces today's daily-challenge record, newest last, oldest dropped past `limit`. */
export const keepDailyChallenge = (
  records: readonly DailyChallengeRecord[],
  record: DailyChallengeRecord,
  limit = 365,
): DailyChallengeRecord[] => {
  const without = records.filter(one => one.date !== record.date)

  return [...without, record].slice(-limit)
}

/** The record for one day, answered or skipped alike — undefined when that day never got one. */
export const challengeFor = (
  records: readonly DailyChallengeRecord[],
  date: string,
): DailyChallengeRecord | undefined => records.find(one => one.date === date)

/**
 * Consecutive days, counting back from the most recent record, that the
 * challenge was both answered and right. A day that was never offered (no
 * turns ran) leaves no record and so cannot break it; a wrong or skipped day
 * does, the same way `currentStreak` treats a miss. A day offered but left
 * untouched (`isNotTaken`) is neither: it is skipped over, counting neither
 * for nor against the run, the same as a day with no record at all.
 */
export const dailyChallengeStreak = (records: readonly DailyChallengeRecord[]): number => {
  let streak = 0
  for (let at = records.length - 1; at >= 0; at--) {
    const record = records[at]
    if (record?.isNotTaken === true) continue
    if (record?.correct !== true) break
    streak++
  }

  return streak
}

/**
 * The `/bet-recap` value for the daily challenge: the streak once there is
 * one worth naming, else today's own result — "not taken" for a challenge
 * that was offered and never answered or declined, distinct from the plain
 * em dash a day with no turns at all reads as.
 */
export const dailyChallengeValue = (records: readonly DailyChallengeRecord[], today: string): string => {
  const streak = dailyChallengeStreak(records)
  if (streak >= 2) return `${streak}-day streak`
  const mine = challengeFor(records, today)
  if (!mine) return '—'
  if (mine.isSkipped) return 'skipped today'
  if (mine.isNotTaken) return 'not taken'

  return mine.correct === undefined ? '—' : mine.correct ? 'right today' : 'missed today'
}

/** One path `git status` reports, and whether it is gone from the working tree. */
export type StatusEntry = { path: string; isDeleted: boolean }

/**
 * The paths in `git status --porcelain=v1 -z` output.
 *
 * Entries are NUL-separated `XY path`; a rename or copy carries its old path
 * as the next field, which is skipped — the file written is the new one.
 */
export const parseStatus = (out: string): StatusEntry[] => {
  const fields = out.split('\0')
  const entries: StatusEntry[] = []
  for (let at = 0; at < fields.length; at++) {
    const field = fields[at] ?? ''
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    entries.push({ path: field.slice(3), isDeleted: code.includes('D') })
    if (code.includes('R') || code.includes('C')) at++
  }

  return entries
}

/**
 * The paths whose content moved between two looks at the working tree.
 *
 * Each look maps a changed path to a hash of its content. A path new to the
 * second look was written; so was one in both with a different hash, and one
 * that dropped out of the second, since it was changed back.
 */
export const changedSince = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] => [
  ...Object.keys(after).filter(path => before[path] !== after[path]),
  ...Object.keys(before).filter(path => !(path in after)),
]

/**
 * The records a confidence forecast can be scored on: one that was bet, has a
 * verdict, and was not interrupted (an interrupted turn says nothing about the
 * agent, only about the person who stopped it).
 */
const scorable = (records: readonly TurnRecord[]): TurnRecord[] =>
  records.filter(
    one =>
      one.saidConfidence !== undefined &&
      one.landed !== undefined &&
      !one.isAborted &&
      one.isVerdictSkipped !== true,
  )

/** A bet still waiting on the person: bet, not yet answered, not waved away. */
const isOwed = (one: TurnRecord): boolean =>
  one.saidConfidence !== undefined &&
  one.landed === undefined &&
  one.isVerdictSkipped !== true &&
  !one.isAborted

export type CalibrationRow = {
  /** The forecast, 0 to 1. */
  said: number
  /** How often it actually landed at that forecast, 0 to 1. */
  actual: number
  turns: number
  lean: 'over' | 'under' | 'fair'
}

/** Within this much, a forecast counts as honest rather than lean either way. */
const SLACK = 0.05

const leanOf = (said: number, actual: number): CalibrationRow['lean'] => {
  if (actual < said - SLACK) return 'over'

  return actual > said + SLACK ? 'under' : 'fair'
}

/**
 * One row per forecast actually used, lowest first: what you said against what
 * happened. This is the part worth reading — a single score hides which kind of
 * turn you misjudge.
 */
export const calibration = (records: readonly TurnRecord[]): CalibrationRow[] => {
  const scored = scorable(records)
  const bands = [...new Set(scored.map(one => one.saidConfidence as number))].sort((a, b) => a - b)

  return bands.map(said => {
    const mine = scored.filter(one => one.saidConfidence === said)
    const landed = mine.filter(one => one.landed === true).length
    const actual = landed / mine.length

    return { said, actual, turns: mine.length, lean: leanOf(said, actual) }
  })
}

const mean = (numbers: readonly number[]): number =>
  numbers.reduce((sum, one) => sum + one, 0) / numbers.length

export const median = (numbers: readonly number[]): number | undefined => {
  if (numbers.length === 0) return undefined
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (upper === undefined) return undefined

  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2
}

/**
 * Ranks, worst to best, from the rolling Brier score. `Unranked` sits first:
 * not the worst rank, no rank at all.
 */
export const RANKS: readonly Rank[] = ['Unranked', 'Coin-Flipper', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Oracle']

/** Scored turns a rolling rank looks back over; older calls age out of it. */
export const RANK_WINDOW = 20

/** Fewer scored turns than this and the rank is `Unranked`, not a guess dressed up as one. */
export const MIN_RANKED = 5

/**
 * The rank cutoffs, worst first, each its own named threshold rather than a
 * table read by position — this is the one place they are set, everywhere
 * else reads `rankOf`.
 */
export const COIN_FLIPPER_BRIER = 0.3
export const BRONZE_BRIER = 0.25
export const SILVER_BRIER = 0.2
export const GOLD_BRIER = 0.15
export const PLATINUM_BRIER = 0.1

const RANK_CUTOFFS: readonly { rank: Rank; atOrAbove: number }[] = [
  { rank: 'Coin-Flipper', atOrAbove: COIN_FLIPPER_BRIER },
  { rank: 'Bronze', atOrAbove: BRONZE_BRIER },
  { rank: 'Silver', atOrAbove: SILVER_BRIER },
  { rank: 'Gold', atOrAbove: GOLD_BRIER },
  { rank: 'Platinum', atOrAbove: PLATINUM_BRIER },
]

/** The rank a rolling Brier score and its scored-turn count land on. */
export const rankOf = (brier: number | undefined, scoredCount: number): Rank => {
  if (brier === undefined || scoredCount < MIN_RANKED) return 'Unranked'
  for (const { rank, atOrAbove } of RANK_CUTOFFS) {
    if (brier >= atOrAbove) return rank
  }

  return 'Oracle'
}

/** Whether `to` sits above `from` in the rank order — a climb, not a fall or a hold. */
export const rankImproved = (from: Rank, to: Rank): boolean => RANKS.indexOf(to) > RANKS.indexOf(from)

/**
 * The Brier score over the most recent `window` scored turns, and how many
 * that was (fewer than `window` early in a history).
 *
 * Rolling rather than lifetime, so the rank reflects how you are calling it
 * lately: a bad week does not haunt a rank forever, and neither does an old
 * good one prop it up.
 */
export const rollingBrier = (
  records: readonly TurnRecord[],
  window = RANK_WINDOW,
): { brier: number | undefined; scored: number } => {
  const scored = scorable(records).slice(-window)
  if (scored.length === 0) return { brier: undefined, scored: 0 }

  return {
    brier: mean(scored.map(one => ((one.saidConfidence as number) - (one.landed ? 1 : 0)) ** 2)),
    scored: scored.length,
  }
}

/** The rank the history stands at right now. */
export const currentRank = (records: readonly TurnRecord[]): Rank => {
  const { brier, scored } = rollingBrier(records)

  return rankOf(brier, scored)
}

/**
 * Consecutive landed calls, oldest to newest, the longest run anywhere in
 * history — unlike `currentStreak`, which only reads the run ending right now.
 */
const longestLandedStreak = (records: readonly TurnRecord[]): number => {
  let longest = 0
  let current = 0
  for (const one of scorable(records)) {
    if (one.landed === true) {
      current++
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }

  return longest
}

/** Whether a run of `window` consecutive scored calls, anywhere in history, ever beat `limit` on its own Brier score. */
const everBeatBrierOverWindow = (records: readonly TurnRecord[], window: number, limit: number): boolean => {
  const scored = scorable(records)
  for (let at = window; at <= scored.length; at++) {
    const run = scored.slice(at - window, at)
    const brier = mean(run.map(one => ((one.saidConfidence as number) - (one.landed ? 1 : 0)) ** 2))
    if (brier < limit) return true
  }

  return false
}

/**
 * Whether the rolling rank, replayed across history the way it was read at
 * the time, ever touched Oracle — unlike `currentRank`, which only reads
 * where it stands now, after a rank has had the chance to climb and fall back.
 */
const everReachedOracle = (records: readonly TurnRecord[]): boolean => {
  const scored = scorable(records)
  for (let at = MIN_RANKED; at <= scored.length; at++) {
    const window = scored.slice(Math.max(0, at - RANK_WINDOW), at)
    const brier = mean(window.map(one => ((one.saidConfidence as number) - (one.landed ? 1 : 0)) ** 2))
    if (rankOf(brier, window.length) === 'Oracle') return true
  }

  return false
}

/** Distinct local calendar days with a scored bet. */
const distinctScoredDays = (records: readonly TurnRecord[]): number =>
  new Set(scorable(records).map(one => localDateKey(one.at))).size

export type BadgeId = 'firstSteps' | 'hotStreak' | 'sharpshooter' | 'oraclePath' | 'bonusHunter' | 'regular'

export type Badge = {
  id: BadgeId
  name: string
  earned: boolean
  /** How far along, for a badge not yet earned; absent once it is, or when there is no partial count worth showing. */
  progress?: { have: number; of: number }
}

/** Consecutive landed calls, anywhere in history, that earns Hot Streak. */
export const HOT_STREAK_TARGET = 5
/** Consecutive scored calls Sharpshooter's own rolling Brier is judged over. */
export const SHARPSHOOTER_WINDOW = 10
/** Correct bonus answers, lifetime, that earns Bonus Hunter. */
export const BONUS_HUNTER_TARGET = 5
/** Distinct days with a scored bet that earns Regular. */
export const REGULAR_TARGET = 5

const badgeOf = (id: BadgeId, name: string, earned: boolean, progress?: { have: number; of: number }): Badge =>
  earned || progress === undefined ? { id, name, earned } : { id, name, earned, progress }

/**
 * The badge wall, computed fresh from the history the plugin already keeps —
 * no badge needs a fact this does not already record. Every badge is always
 * in the list, earned or not, so the wall never changes shape.
 */
export const badges = (records: readonly TurnRecord[]): Badge[] => {
  const scoredCount = scorable(records).length
  const bonusRight = records.filter(
    one => !one.isAborted && one.saidBonus !== undefined && one.saidBonus === one.bonusActual,
  ).length
  const streak = longestLandedStreak(records)
  const days = distinctScoredDays(records)

  return [
    badgeOf('firstSteps', 'First Steps', scoredCount >= 1),
    badgeOf('hotStreak', 'Hot Streak', streak >= HOT_STREAK_TARGET, { have: streak, of: HOT_STREAK_TARGET }),
    badgeOf('sharpshooter', 'Sharpshooter', everBeatBrierOverWindow(records, SHARPSHOOTER_WINDOW, SILVER_BRIER), {
      have: Math.min(scoredCount, SHARPSHOOTER_WINDOW),
      of: SHARPSHOOTER_WINDOW,
    }),
    badgeOf('oraclePath', 'Oracle Path', everReachedOracle(records)),
    badgeOf('bonusHunter', 'Bonus Hunter', bonusRight >= BONUS_HUNTER_TARGET, {
      have: Math.min(bonusRight, BONUS_HUNTER_TARGET),
      of: BONUS_HUNTER_TARGET,
    }),
    badgeOf('regular', 'Regular', days >= REGULAR_TARGET, { have: Math.min(days, REGULAR_TARGET), of: REGULAR_TARGET }),
  ]
}

export type Report = {
  /** Turns a confidence forecast was scored on. */
  scored: number
  /** Turns recorded at all, bet on or not. */
  recorded: number
  brier?: number
  rows: CalibrationRow[]
  /** How often the file-count forecast was exactly right. */
  files?: { right: number; of: number }
  /** How often the bonus question was answered right, whichever dimension it asked each turn. */
  bonus?: { right: number; of: number }
  /** How often the agent actually landed it first try, by your own verdict. */
  landed?: { yes: number; of: number }
  medianMs?: number
  /** Awaiting your verdict. */
  owed: number
  /** The widest misses, for the part of the report that teaches. */
  misses: Miss[]
  lean?: 'over' | 'under' | 'fair'
  /** Percentage points between what you said on average and what happened. */
  gap?: number
  /** The rank the rolling Brier score stands at right now. */
  rank: Rank
}

export const report = (records: readonly TurnRecord[]): Report => {
  const scored = scorable(records)
  const live = records.filter(one => !one.isAborted)
  const filesBet = live.filter(one => one.saidFiles !== undefined)
  const bonusBet = live.filter(one => one.saidBonus !== undefined)
  const owed = records.filter(isOwed).length

  const base: Report = {
    scored: scored.length,
    recorded: records.length,
    rows: calibration(records),
    owed,
    medianMs: median(live.map(one => one.durationMs)),
    misses: worstCalls(records),
    rank: currentRank(records),
  }

  if (filesBet.length > 0) {
    base.files = {
      right: filesBet.filter(one => one.saidFiles === one.filesBucket).length,
      of: filesBet.length,
    }
  }

  if (bonusBet.length > 0) {
    base.bonus = {
      right: bonusBet.filter(one => one.saidBonus === one.bonusActual).length,
      of: bonusBet.length,
    }
  }

  if (scored.length === 0) return base

  const said = mean(scored.map(one => one.saidConfidence as number))
  const actual = scored.filter(one => one.landed === true).length / scored.length

  return {
    ...base,
    brier: mean(scored.map(one => ((one.saidConfidence as number) - (one.landed ? 1 : 0)) ** 2)),
    landed: { yes: scored.filter(one => one.landed === true).length, of: scored.length },
    lean: leanOf(said, actual),
    gap: Math.round((said - actual) * 100),
  }
}

/**
 * The bet to ask about: the latest one still waiting on a verdict.
 *
 * It used to be the oldest, which a live session showed was wrong: you bet on
 * a turn, watch it land, and get asked about one from forty minutes earlier
 * instead. The turn that just landed is the one on screen and in mind; any
 * older ones wait behind it until they lapse. Records are kept newest last, so
 * a tie on the clock goes to the later one.
 */
export const owedVerdict = (records: readonly TurnRecord[]): TurnRecord | undefined =>
  records
    .filter(isOwed)
    .reduce<TurnRecord | undefined>(
      (latest, one) => (latest === undefined || one.at >= latest.at ? one : latest),
      undefined,
    )

/** Waves the verdict away: the turn stays recorded but owes and scores nothing. */
export const skipVerdict = (
  records: readonly TurnRecord[],
  turnId: string,
): TurnRecord[] =>
  records.map(one => (one.turnId === turnId ? { ...one, isVerdictSkipped: true as const } : one))

/**
 * How long a bet waits on its verdict before it lapses.
 *
 * "Did it land?" is only answerable while the turn is still in mind. Without
 * a limit, a bet left unanswered at the end of a day opened the next day's
 * session by asking about work nobody remembered — and a verdict guessed at
 * then is noise in the score, not signal.
 */
export const VERDICT_WINDOW_MS = 4 * 60 * 60 * 1000

/**
 * Waves away every verdict owed for longer than the window, as a skip would.
 *
 * Hands `records` itself back when nothing lapsed, so the caller can tell
 * there is nothing to write.
 */
export const lapseVerdicts = (records: TurnRecord[], now: number): TurnRecord[] => {
  const hasLapsed = (one: TurnRecord) => isOwed(one) && now - one.at > VERDICT_WINDOW_MS

  return records.some(hasLapsed)
    ? records.map(one => (hasLapsed(one) ? { ...one, isVerdictSkipped: true as const } : one))
    : records
}

export type Miss = {
  ask?: string
  said: number
  landed: boolean
  /** Squared error of this one call: how far the forecast was from the event. */
  error: number
}

/**
 * The calls that went worst, widest first.
 *
 * The table says you are overconfident; this says what about. It is the part
 * that teaches, because a forecast is only ever wrong about a specific ask.
 */
export const worstCalls = (records: readonly TurnRecord[], limit = 3): Miss[] =>
  scorable(records)
    .map(one => {
      const said = one.saidConfidence as number
      const landed = one.landed === true

      return { ask: one.ask, said, landed, error: (said - (landed ? 1 : 0)) ** 2 }
    })
    .filter(one => one.error > 0.25)
    .sort((a, b) => b.error - a.error)
    .slice(0, limit)

/**
 * The single best and single worst scored calls, by squared error — no
 * threshold, unlike `worstCalls`: the recap wants a worst call even in a
 * session with nothing bad enough to make that list.
 */
export const extremeCalls = (records: readonly TurnRecord[]): { best?: Miss; worst?: Miss } => {
  const scored = scorable(records)
    .map(one => {
      const said = one.saidConfidence as number
      const landed = one.landed === true

      return { ask: one.ask, said, landed, error: (said - (landed ? 1 : 0)) ** 2 }
    })
    .sort((a, b) => a.error - b.error)
  if (scored.length === 0) return {}

  return { best: scored[0], worst: scored[scored.length - 1] }
}

/**
 * Consecutive landed calls counting back from the most recent scored turn,
 * broken by the first miss. An unscored or skipped turn is neither a hit nor
 * a break — it is simply not in the scored sequence this walks.
 */
export const currentStreak = (records: readonly TurnRecord[]): number => {
  const scored = scorable(records)
  let streak = 0
  for (let at = scored.length - 1; at >= 0; at--) {
    if (scored[at]?.landed !== true) break
    streak++
  }

  return streak
}

/** Adds or replaces a record, newest last, oldest dropped past `limit`. */
export const keepRecord = (
  records: readonly TurnRecord[],
  record: TurnRecord,
  limit = 500,
): TurnRecord[] => {
  const without = records.filter(one => one.turnId !== record.turnId)

  return [...without, record].slice(-limit)
}

/** Records the person's verdict on a turn, leaving every other record alone. */
export const setVerdict = (
  records: readonly TurnRecord[],
  turnId: string,
  landed: boolean,
): TurnRecord[] => records.map(one => (one.turnId === turnId ? { ...one, landed } : one))

/** Puts a turn back to owed: undoes `setVerdict` or `skipVerdict` on it. */
export const undoVerdict = (records: readonly TurnRecord[], turnId: string): TurnRecord[] =>
  records.map(one => {
    if (one.turnId !== turnId) return one
    const { landed: _landed, isVerdictSkipped: _skipped, ...rest } = one

    return rest
  })

export const asPercent = (value: number): string => `${Math.round(value * 100)}%`

/** `48s`, or `2m 5s` once a turn runs past a minute. */
export const asDuration = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** How wide a slice of the prompt anchors a bet. */
export const ASK_ROOM = 48

/** A UTF-16 code unit that is the first half of a surrogate pair (an emoji, among others). */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** The opening of a prompt, on one line, for the band and the record. */
export const shortAsk = (text: string, room = ASK_ROOM): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (room < 1) return ''
  if (flat.length <= room) return flat

  const cut = room - 1
  // A cut landing between the two halves of a surrogate pair would otherwise
  // leave a lone, broken code unit right before the ellipsis.
  const safeCut = cut > 0 && isHighSurrogate(flat.charCodeAt(cut - 1)) ? cut - 1 : cut

  return `${flat.slice(0, safeCut).trimEnd()}…`
}

/** The most of a live ask the band quotes, however wide the terminal. */
export const BAND_ASK_ROOM = 64

/** The `bet` tag, `Will "" land first try?` and the space around them. */
const QUESTION_CHROME = 32

/** The `bet` tag, `Did it land? you said 95% · ""` and the space around them. */
export const VERDICT_CHROME = 38

/**
 * How much of the ask the band's question line can quote.
 *
 * The answers have a line of their own, so the ask competes only with the
 * question's own words; below a dozen characters a quote says nothing and is
 * dropped rather than shown as a stub.
 */
export const askRoomFor = (bodyColumns: number, chrome = QUESTION_CHROME): number => {
  const left = Math.min(BAND_ASK_ROOM, bodyColumns - chrome)

  return left < 12 ? 0 : left
}

/**
 * Scored calls before the headline says which way you lean.
 *
 * Two calls that missed read as "80 points overconfident", which is a verdict
 * on almost nothing and stings exactly when someone is deciding whether to keep
 * betting. Under this many the headline counts up instead.
 */
export const MIN_SCORED = 5

/** Whether there are too few scored calls yet for the lean to mean anything. */
export const isCalibrating = (found: Report): boolean => found.scored < MIN_SCORED

/**
 * How each file bucket reads as an answer.
 *
 * The answers are pressed by digit, so a label that is itself a digit
 * misleads: `1: 0  2: 1` had "one file" on the 2 key. Words for the two small
 * buckets keep every key from reading as a different count.
 */
export const FILE_LABELS: Readonly<Record<FileBucket, string>> = {
  '0': 'none',
  '1': 'one',
  '2-3': '2–3',
  '4+': '4+',
}

/** A file bucket in a sentence: "2–3 files", "1 file", "no files". */
export const filesPhrase = (bucket: FileBucket): string =>
  bucket === '0' ? 'no files' : bucket === '1' ? '1 file' : `${FILE_LABELS[bucket]} files`

/**
 * The worst calls with repeats folded together, so asking the same thing twice
 * reads as one line marked ×2 rather than the same line twice.
 */
export const groupMisses = (misses: readonly Miss[]): { miss: Miss; count: number }[] => {
  const groups: { miss: Miss; count: number }[] = []
  for (const miss of misses) {
    const same = groups.find(
      one => one.miss.ask === miss.ask && one.miss.said === miss.said && one.miss.landed === miss.landed,
    )
    if (same) same.count++
    else groups.push({ miss, count: 1 })
  }

  return groups
}

/**
 * The headline, in words rather than a score.
 *
 * "Brier 0.147" tells almost nobody anything on its own, so the lean leads and
 * the number backs it up.
 */
export const headline = (found: Report): string => {
  if (isCalibrating(found)) return `Calibrating: ${found.scored} of ${MIN_SCORED} calls scored.`
  if (found.lean === 'over') return `You run ${found.gap} points overconfident.`
  if (found.lean === 'under') {
    return `You run ${Math.abs(found.gap ?? 0)} points underconfident.`
  }

  return 'Your forecasts match what happens.'
}

/** The column heading the calibration rows line up under. */
export const CALIBRATION_HEAD = ' said     actual   turns'

/**
 * One calibration row, padded so a column of them lines up.
 *
 * Shared by the pane and the slash command so the two can never drift, and
 * built as one padded string rather than laid out in boxes because a terminal
 * aligns monospace text more reliably than it aligns flex children.
 */
export const calibrationLine = (row: CalibrationRow): string => {
  const said = asPercent(row.said).padStart(5)
  const actual = asPercent(row.actual).padStart(6)
  const turns = String(row.turns).padStart(4)
  const lean = row.lean === 'fair' ? '' : `   ${row.lean}confident`

  return `${said} →  ${actual} ${turns}${lean}`
}

/**
 * The report as the slash command prints it.
 *
 * `rankUp` is not derived from `found`: it is the climb, if any, the verdict
 * that produced this report just caused, read off `LastVerdict` by the
 * caller. A pure function of the report alone could not say that.
 */
export const asText = (found: Report, rankUp?: RankChange): string => {
  if (found.recorded === 0) return 'No turns recorded yet. Call the next one while it runs.'
  if (found.brier === undefined) {
    const files = found.files ? ` File count called right ${found.files.right}/${found.files.of}.` : ''
    const bonus = found.bonus ? ` Bonus: ${found.bonus.right}/${found.bonus.of} correct.` : ''
    const owed = found.owed > 0 ? ` ${found.owed} waiting on your verdict.` : ''

    return `${found.recorded} turns recorded, none scored yet.${files}${bonus}${owed}`
  }

  const skill =
    found.brier < COIN_FLIP_BRIER ? 'better than a coin flip' : 'no better than a coin flip'
  const lines: string[] = [
    headline(found),
    isCalibrating(found)
      ? `The score means something from ${MIN_SCORED} calls; until then, here is what there is.`
      : `Brier ${found.brier.toFixed(3)} over ${found.scored} scored turns — ${skill}.`,
    `Rank: ${found.rank}.`,
  ]

  if (rankUp) lines.push(`Rank up: ${rankUp.from} -> ${rankUp.to}`)

  if (found.rows.length > 0) {
    lines.push('', CALIBRATION_HEAD)
    for (const row of found.rows) lines.push(calibrationLine(row))
  }

  if (found.misses.length > 0) {
    lines.push('', 'Worst calls')
    for (const { miss, count } of groupMisses(found.misses)) {
      const said = asPercent(miss.said)
      const what = miss.landed ? 'and it landed' : 'and it did not'
      const times = count > 1 ? ` (×${count})` : ''
      lines.push(`  ${said} ${what}${times} — ${miss.ask ?? 'a turn with no prompt'}`)
    }
  }

  lines.push('')
  if (found.files) lines.push(`File count called right ${found.files.right}/${found.files.of}.`)
  if (found.bonus) lines.push(`Bonus: ${found.bonus.right}/${found.bonus.of} correct.`)
  if (found.landed) {
    const percent = asPercent(found.landed.yes / found.landed.of)
    lines.push(`The agent landed it first try ${percent} (${found.landed.yes}/${found.landed.of}).`)
  }
  if (found.medianMs !== undefined) lines.push(`Median turn ${asDuration(found.medianMs)}.`)
  if (found.owed > 0) lines.push(`${found.owed} bet${found.owed === 1 ? '' : 's'} waiting on your verdict.`)

  return lines.join('\n')
}

export type Recap = {
  turnsBet: number
  turnsScored: number
  brier?: number
  best?: Miss
  worst?: Miss
  rank: Rank
  streak: number
  bonus?: { right: number; of: number }
  /** The badge wall, earned and locked alike — always the full set. */
  badges: Badge[]
  /** The daily challenge's own line: a streak once there is one, else today's result. */
  dailyChallenge: string
}

/**
 * The session's recap, computed once so the card itself is pure layout.
 *
 * `rank` and `badges` read `all` the history, not `session` alone: a rank
 * and a badge wall are who you are right now, not something that resets at
 * midnight. Everything else is scoped to `session`, the records since this
 * session began.
 */
export const recapOf = (
  session: readonly TurnRecord[],
  all: readonly TurnRecord[],
  dailyChallenges: readonly DailyChallengeRecord[],
  today: string,
): Recap => {
  const found = report(session)
  const { best, worst } = extremeCalls(session)

  return {
    turnsBet: session.filter(one => !one.isAborted && one.saidConfidence !== undefined).length,
    turnsScored: found.scored,
    brier: found.brier,
    best,
    worst,
    rank: currentRank(all),
    streak: currentStreak(session),
    bonus: found.bonus,
    badges: badges(all),
    dailyChallenge: dailyChallengeValue(dailyChallenges, today),
  }
}

/** How much of a recap row the ask gets once its own label and verdict are placed. */
const RECAP_ASK_ROOM = 40

const missLine = (miss: Miss): string => {
  const prefix = `${asPercent(miss.said)} ${miss.landed ? 'and it landed' : 'and it did not'} — `

  return `${prefix}${shortAsk(miss.ask ?? 'a turn with no prompt', Math.max(0, RECAP_ASK_ROOM - prefix.length))}`
}

/** A recap row's label column, so every value lines up under the next — wide enough for "Daily challenge", its longest label. */
const RECAP_LABEL = 16

const recapRow = (label: string, value: string): string => `${label.padEnd(RECAP_LABEL)}${value}`

/**
 * A shareable, plain-text recap card: box-drawn, no color inside it, so it
 * pastes cleanly anywhere. Every field the spec names shows on its own row,
 * in order, with an em dash standing in for one with nothing to say yet
 * (no scored turn, no bonus answered) — a card keeps its shape whether the
 * session behind it is thin or full.
 */
/** A badge's value column: a check once earned, else its progress hint or an em dash. */
const badgeValue = (badge: Badge): string => {
  if (badge.earned) return '✓'

  return badge.progress ? `${badge.progress.have}/${badge.progress.of}` : '—'
}

export const recapCard = (recap: Recap): string => {
  const title = 'Session recap'
  const rows = [
    recapRow('Turns bet', String(recap.turnsBet)),
    recapRow('Turns scored', String(recap.turnsScored)),
    recapRow('Session Brier', recap.brier === undefined ? '—' : recap.brier.toFixed(3)),
    recapRow('Best call', recap.best ? missLine(recap.best) : '—'),
    recapRow('Worst call', recap.worst ? missLine(recap.worst) : '—'),
    recapRow('Rank', recap.rank),
    recapRow('Streak', String(recap.streak)),
    recapRow('Bonus', recap.bonus ? `${recap.bonus.right}/${recap.bonus.of} correct` : '—'),
    recapRow('Daily challenge', recap.dailyChallenge),
  ]
  const badgeRows = recap.badges.map(badge => recapRow(badge.name, badgeValue(badge)))
  const width = Math.max(title.length, ...rows.map(row => row.length), ...badgeRows.map(row => row.length))
  const border = (corner: readonly [string, string]) => `${corner[0]}${'─'.repeat(width + 2)}${corner[1]}`
  const line = (text: string) => `│ ${text.padEnd(width)} │`

  return [
    border(['┌', '┐']),
    line(title),
    line('─'.repeat(width)),
    ...rows.map(line),
    line('─'.repeat(width)),
    line('Badges'),
    ...badgeRows.map(line),
    border(['└', '┘']),
  ].join('\n')
}
