/**
 * Scoring: no engine, no $, so `claude plugin test` exercises it directly.
 *
 * The scoring rule is the Brier score, mean squared error of a forecast against
 * what happened. It is proper: you cannot improve it by shading your answer
 * away from what you actually believe, which is the whole point of scoring
 * calibration rather than counting wins.
 */

import type { FileBucket, TurnRecord } from '../types'

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

export type Report = {
  /** Turns a confidence forecast was scored on. */
  scored: number
  /** Turns recorded at all, bet on or not. */
  recorded: number
  brier?: number
  rows: CalibrationRow[]
  /** How often the file-count forecast was exactly right. */
  files?: { right: number; of: number }
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
}

export const report = (records: readonly TurnRecord[]): Report => {
  const scored = scorable(records)
  const live = records.filter(one => !one.isAborted)
  const filesBet = live.filter(one => one.saidFiles !== undefined)
  const owed = records.filter(isOwed).length

  const base: Report = {
    scored: scored.length,
    recorded: records.length,
    rows: calibration(records),
    owed,
    medianMs: median(live.map(one => one.durationMs)),
    misses: worstCalls(records),
  }

  if (filesBet.length > 0) {
    base.files = {
      right: filesBet.filter(one => one.saidFiles === one.filesBucket).length,
      of: filesBet.length,
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

/** The opening of a prompt, on one line, for the band and the record. */
export const shortAsk = (text: string, room = ASK_ROOM): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (room < 1) return ''
  if (flat.length <= room) return flat

  return `${flat.slice(0, room - 1).trimEnd()}…`
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

/** The report as the slash command prints it. */
export const asText = (found: Report): string => {
  if (found.recorded === 0) return 'No turns recorded yet. Call the next one while it runs.'
  if (found.brier === undefined) {
    const owed = found.owed > 0 ? ` ${found.owed} waiting on your verdict.` : ''

    return `${found.recorded} turns recorded, none scored yet.${owed}`
  }

  const skill =
    found.brier < COIN_FLIP_BRIER ? 'better than a coin flip' : 'no better than a coin flip'
  const lines: string[] = [
    headline(found),
    isCalibrating(found)
      ? `The score means something from ${MIN_SCORED} calls; until then, here is what there is.`
      : `Brier ${found.brier.toFixed(3)} over ${found.scored} scored turns — ${skill}.`,
  ]

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
  if (found.landed) {
    const percent = asPercent(found.landed.yes / found.landed.of)
    lines.push(`The agent landed it first try ${percent} (${found.landed.yes}/${found.landed.of}).`)
  }
  if (found.medianMs !== undefined) lines.push(`Median turn ${asDuration(found.medianMs)}.`)
  if (found.owed > 0) lines.push(`${found.owed} bet${found.owed === 1 ? '' : 's'} waiting on your verdict.`)

  return lines.join('\n')
}
