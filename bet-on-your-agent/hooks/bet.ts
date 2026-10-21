/**
 * Scoring: no engine, no $, so `claude plugin test` exercises it directly.
 *
 * The scoring rule is the Brier score, mean squared error of a forecast against
 * what happened. It is proper: you cannot improve it by shading your answer
 * away from what you actually believe, which is the whole point of scoring
 * calibration rather than counting wins.
 */

import type { BonusBucket, BonusDim, Rank, RankChange, FileBucket, TurnRecord } from '../types'

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
}

/**
 * The session's recap, computed once so the card itself is pure layout.
 *
 * `rank` reads `all` the history, not `session` alone: a rank is who you are
 * right now, not something that resets at midnight. Everything else is
 * scoped to `session`, the records since this session began.
 */
export const recapOf = (session: readonly TurnRecord[], all: readonly TurnRecord[]): Recap => {
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
  }
}

/** How much of a recap row the ask gets once its own label and verdict are placed. */
const RECAP_ASK_ROOM = 40

const missLine = (miss: Miss): string => {
  const prefix = `${asPercent(miss.said)} ${miss.landed ? 'and it landed' : 'and it did not'} — `

  return `${prefix}${shortAsk(miss.ask ?? 'a turn with no prompt', Math.max(0, RECAP_ASK_ROOM - prefix.length))}`
}

/** A recap row's label column, so every value lines up under the next. */
const RECAP_LABEL = 14

const recapRow = (label: string, value: string): string => `${label.padEnd(RECAP_LABEL)}${value}`

/**
 * A shareable, plain-text recap card: box-drawn, no color inside it, so it
 * pastes cleanly anywhere. Every field the spec names shows on its own row,
 * in order, with an em dash standing in for one with nothing to say yet
 * (no scored turn, no bonus answered) — a card keeps its shape whether the
 * session behind it is thin or full.
 */
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
  ]
  const width = Math.max(title.length, ...rows.map(row => row.length))
  const border = (corner: readonly [string, string]) => `${corner[0]}${'─'.repeat(width + 2)}${corner[1]}`
  const line = (text: string) => `│ ${text.padEnd(width)} │`

  return [
    border(['┌', '┐']),
    line(title),
    line('─'.repeat(width)),
    ...rows.map(line),
    border(['└', '┘']),
  ].join('\n')
}
