import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BonusBucket, DailyChallengeRecord, DailyGuess, FileBucket, LastVerdict, OpenBet, TurnRecord } from '../types'
import {
  asDuration,
  askRoomFor,
  asPercent,
  asText,
  badges,
  badgeValue,
  BANDS,
  bonusBucketOf,
  bonusDimFor,
  bonusLabel,
  BONUS_BUCKETS,
  BONUS_QUESTIONS,
  CALIBRATION_HEAD,
  calibrationLine,
  bucketOf,
  challengeFor,
  challengeQuestion,
  challengeThreshold,
  changedSince,
  COIN_FLIP_BRIER,
  currentRank,
  dailyChallengeDimFor,
  dailyOutcome,
  FILE_BUCKETS,
  FILE_LABELS,
  filesPhrase,
  groupMisses,
  headline,
  isCalibrating,
  keepDailyChallenge,
  keepRecord,
  lapseVerdicts,
  localDateKey,
  MIN_SCORED,
  owedVerdict,
  parseStatus,
  rankImproved,
  recapCard,
  recapOf,
  report,
  setVerdict,
  shortAsk,
  skipVerdict,
  undoVerdict,
  VERDICT_CHROME,
} from './bet'

const PANE = 'bet-on-your-agent'
const STORE_KEY = 'turns'
const DAILY_CHALLENGE_STORE_KEY = 'dailyChallenges'

const NO_BET: OpenBet = { turnId: '', ask: '', files: [], toolCalls: 0 }

const open = atom({ plugin: 'bet-on-your-agent', key: 'open' } as const, NO_BET)
const busy = atom({ plugin: 'bet-on-your-agent', key: 'busy' } as const, false)
const lastVerdict = atom(
  { plugin: 'bet-on-your-agent', key: 'lastVerdict' } as const,
  null as LastVerdict | null,
)
const revision = atom({ plugin: 'bet-on-your-agent', key: 'revision' } as const, 0)
/** The most recent "Badge earned" note, shown once beside the band's own scoring output. */
const badgeNote = atom({ plugin: 'bet-on-your-agent', key: 'badgeNote' } as const, null as string | null)
/** How many turns have offered a bonus question so far; drives the rotation. */
const bonusRotation = atom({ plugin: 'bet-on-your-agent', key: 'bonusRotation' } as const, 0)
/** When this session began, for the recap card's "this session". */
const sessionStartedAt = atom(
  { plugin: 'bet-on-your-agent', key: 'sessionStartedAt' } as const,
  null as number | null,
)

type Config = { autoOpen: boolean }

/** The stored history, or nothing when the store holds something else. */
const loadTurns = async ($: EngineInterface): Promise<TurnRecord[]> => {
  const raw = await $.store.get(STORE_KEY).catch(() => undefined)

  return Array.isArray(raw) ? (raw as TurnRecord[]) : []
}

/**
 * Writes the history and bumps `revision`.
 *
 * A `$.store` read does not subscribe a drawing, so without the bump the band
 * and pane would keep showing the history as it stood when last drawn.
 */
const saveTurns = async ($: EngineInterface, records: readonly TurnRecord[]) => {
  await $.store.set(STORE_KEY, records)
  await update($, revision, at => at + 1)
}

/** The daily-challenge log, or nothing when the store holds something else. */
const loadDailyChallenges = async ($: EngineInterface): Promise<DailyChallengeRecord[]> => {
  const raw = await $.store.get(DAILY_CHALLENGE_STORE_KEY).catch(() => undefined)

  return Array.isArray(raw) ? (raw as DailyChallengeRecord[]) : []
}

const saveDailyChallenges = async ($: EngineInterface, records: readonly DailyChallengeRecord[]) => {
  await $.store.set(DAILY_CHALLENGE_STORE_KEY, records)
  await update($, revision, at => at + 1)
}

/**
 * Compares the badge wall before and after a write, and names whatever is
 * newly earned in one quiet note — the badges computed here need no fact
 * beyond what `before`/`after` already carry.
 */
const noteBadges = async ($: EngineInterface, before: readonly TurnRecord[], after: readonly TurnRecord[]) => {
  const earnedBefore = new Set(badges(before).filter(one => one.earned).map(one => one.id))
  const newlyEarned = badges(after).filter(one => one.earned && !earnedBefore.has(one.id))
  if (newlyEarned.length === 0) return
  await update($, badgeNote, () => `Badge earned: ${newlyEarned.map(one => one.name).join(', ')}`)
}

/**
 * The status line, which is a convenience: it never throws outward, because a
 * failure here would otherwise abort whatever hook was keeping it up to date —
 * including the one that records the turn.
 */
const showStatus = async ($: EngineInterface) => {
  try {
    const isBusy = await read($, busy)
    const bet = await read($, open)
    // The engine already prefixes the plugin's own name, so the text says only
    // what to do next, which is what a status line is for.
    if (isBusy) {
      if (bet.isDeclined === true) {
        $.ui.status(undefined)

        return
      }
      $.ui.status(
        bet.saidConfidence === undefined
          ? 'type 1–5 to call this turn'
          : `you said ${asPercent(bet.saidConfidence)}`,
      )

      return
    }
    const found = report(await loadTurns($))
    if (found.owed > 0) {
      $.ui.status(`did it land? ${found.owed === 1 ? '1 to answer' : `${found.owed} to answer`}`)

      return
    }
    $.ui.status(
      found.brier === undefined ? undefined : `${headline(found).replace(/\.$/, '')} · /bet`,
    )
  } catch {
    // Nothing to do: the record is still kept, only unshown.
  }
}

const placeConfidence = async ($: EngineInterface, said: number) => {
  await update($, open, bet => ({ ...bet, saidConfidence: said }))
  await showStatus($)
}

const placeFiles = async ($: EngineInterface, said: FileBucket) => {
  await update($, open, bet => ({ ...bet, saidFiles: said }))
  await showStatus($)
}

const placeBonus = async ($: EngineInterface, said: BonusBucket) => {
  await update($, open, bet => ({ ...bet, saidBonus: said }))
  await showStatus($)
}

/** Waves this turn's bonus question away: its own skip, costing nothing. */
const declineBonus = async ($: EngineInterface) => {
  await update($, open, bet => ({ ...bet, isBonusDeclined: true as const }))
  await showStatus($)
}

const placeDailyChallenge = async ($: EngineInterface, said: DailyGuess) => {
  await update($, open, bet => ({ ...bet, saidDailyChallenge: said }))
  await showStatus($)
}

/** Waves today's challenge away: its own skip, marking the day handled without costing anything. */
const declineDailyChallenge = async ($: EngineInterface) => {
  await update($, open, bet => ({ ...bet, isDailyChallengeDeclined: true as const }))
  await showStatus($)
}

/** Waves this turn's bet away, so the band stops asking for the rest of it. */
const declineBet = async ($: EngineInterface) => {
  await update($, open, bet => ({ ...bet, isDeclined: true as const }))
  await showStatus($)
}

const giveVerdict = async ($: EngineInterface, turnId: string, landed: boolean) => {
  const before = await loadTurns($)
  const fromRank = currentRank(before)
  const after = setVerdict(before, turnId, landed)
  await saveTurns($, after)
  await noteBadges($, before, after)
  const toRank = currentRank(after)
  await update($, lastVerdict, () => ({
    turnId,
    result: landed ? 'landed' : 'fixed',
    ...(rankImproved(fromRank, toRank) ? { rankUp: { from: fromRank, to: toRank } } : {}),
  }))
  await showStatus($)
}

const waveVerdict = async ($: EngineInterface, turnId: string) => {
  await saveTurns($, skipVerdict(await loadTurns($), turnId))
  await update($, lastVerdict, () => ({ turnId, result: 'skipped' }))
  await showStatus($)
}

/** Lets go of the verdicts too old to answer, so a session never opens on one. */
const lapseStaleVerdicts = async ($: EngineInterface) => {
  const records = await loadTurns($)
  const kept = lapseVerdicts(records, await $.clock.now())
  if (kept !== records) await saveTurns($, kept)
}

/** Puts the last verdict back to owed, so misreading it costs one press, not a wrong score. */
const undoLastVerdict = async ($: EngineInterface) => {
  const last = await read($, lastVerdict)
  if (!last) return
  await saveTurns($, undoVerdict(await loadTurns($), last.turnId))
  await update($, lastVerdict, () => null)
  await showStatus($)
}

const noteFile = async ($: EngineInterface, path: string | undefined) => {
  if (path === undefined || path === '') return
  await update($, open, bet =>
    bet.files.includes(path) ? bet : { ...bet, files: [...bet.files, path].slice(-200) },
  )
}

/**
 * Counts every tool call the turn makes, whichever tool and whether or not it
 * was denied — the bonus question asks "how many", not "how many that ran".
 */
const noteToolCall = async ($: EngineInterface) => {
  await update($, open, bet => ({ ...bet, toolCalls: bet.toolCalls + 1 }))
}

/** Past this many changed files, a look at the working tree is not worth its cost. */
const WORKTREE_LIMIT = 500

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/**
 * Each file git sees changed in the repository, as path to content hash.
 *
 * Undefined outside a repository, or when git does not answer; the tool calls
 * are then the only count there is.
 */
const lookAtWorktree = async ($: EngineInterface): Promise<Record<string, string> | undefined> => {
  const top = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = top?.exitCode === 0 ? top.stdout.trim() : ''
  if (root === '') return undefined
  const status = await runGit($, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
  if (status?.exitCode !== 0) return undefined
  const entries = parseStatus(status.stdout)
  if (entries.length > WORKTREE_LIMIT) return undefined
  const present = entries.filter(one => !one.isDeleted).map(one => one.path)
  const hashed = present.length === 0 ? undefined : await runGit($, ['hash-object', '--', ...present], root)
  if (present.length > 0 && hashed?.exitCode !== 0) return undefined
  const hashes = hashed?.stdout.split('\n') ?? []
  const look: Record<string, string> = {}
  for (const one of entries) {
    look[`${root}/${one.path}`] = one.isDeleted ? 'deleted' : (hashes[present.indexOf(one.path)] ?? '')
  }

  return look
}

/**
 * Counts every file whose content moved since the turn started, however it
 * was written: a shell heredoc or a script makes no Edit call.
 */
const noteWorktreeFiles = async ($: EngineInterface) => {
  const { baseline } = await read($, open)
  if (baseline === undefined) return
  const now = await lookAtWorktree($)
  if (now === undefined) return
  const moved = changedSince(baseline, now)
  await update($, open, bet => {
    const added = moved.filter(path => !bet.files.includes(path))

    return added.length === 0 ? bet : { ...bet, files: [...bet.files, ...added].slice(-200) }
  })
}

export const register: Register = (on, options) => {
  const config: Config = { autoOpen: options.autoOpen === true }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bet',
      description: 'How well you call your agent: Brier score and calibration',
    })
    await $.command.register({
      name: 'bet-recap',
      description: 'A shareable, plain-text recap card for this session',
    })
    if (config.autoOpen) void $.ui.open({ id: PANE, title: 'Bet on your agent' }).catch(() => undefined)
    // Guarded: session.start fires again on every hot reload while $.state
    // survives it, so an unconditional write would move "this session" to
    // whatever moment the reload happened rather than when it truly began.
    if ((await read($, sessionStartedAt)) === null) {
      const now = await $.clock.now()
      await update($, sessionStartedAt, () => now)
    }
    await lapseStaleVerdicts($)
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bet' }, async $ => {
    void $.ui.open({ id: PANE, title: 'Bet on your agent' }).catch(() => undefined)
    const last = await read($, lastVerdict)

    return { text: asText(report(await loadTurns($)), last?.rankUp) }
  })

  on('command.run', { command: 'bet-recap' }, async $ => {
    const all = await loadTurns($)
    const startedAt = await read($, sessionStartedAt)
    const session = startedAt === null ? all : all.filter(one => one.at >= startedAt)
    const dailyChallenges = await loadDailyChallenges($)
    const today = localDateKey(await $.clock.now())

    return { text: recapCard(recapOf(session, all, dailyChallenges, today)) }
  })

  // One hook per tool so `e` narrows to that tool's own input.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteFile($, e.file_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteFile($, e.file_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteFile($, e.notebook_path)

    return ran
  }).catch(($, e, next) => next(e))

  // A failed command can still have written files, so only a denied one is skipped.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny) await noteWorktreeFiles($)

    return ran
  }).catch(($, e, next) => next(e))

  // Unfiltered: every tool the turn calls, not only the ones the hooks above
  // already watch for files, is a tool call toward the bonus question.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await noteToolCall($)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const dim = bonusDimFor(await read($, bonusRotation))
    await update($, bonusRotation, at => at + 1)
    // Today's challenge, if today does not already have one: answered,
    // declined or left untouched, a day is handled and not offered again on
    // a later turn.
    const today = localDateKey(await $.clock.now())
    const dailyLog = await loadDailyChallenges($)
    const dailyDim = challengeFor(dailyLog, today) === undefined ? dailyChallengeDimFor(today) : undefined
    // The betting window opens here and closes when the turn lands.
    await update($, open, () => ({
      turnId: e.turnId,
      ask: e.text,
      files: [],
      toolCalls: 0,
      bonusDim: dim,
      ...(dailyDim === undefined ? {} : { dailyChallengeDim: dailyDim }),
    }))
    await update($, busy, () => true)
    // A new turn's own questions take over the band; the last verdict is
    // settled by now, or it would still be the one being asked about.
    await update($, lastVerdict, () => null)
    await update($, badgeNote, () => null)
    // A session can run past the window too.
    await lapseStaleVerdicts($)
    await showStatus($)
    // Taken before the turn runs, so whatever it writes shows as a change.
    const baseline = await lookAtWorktree($)
    if (baseline !== undefined) {
      await update($, open, bet => (bet.turnId === e.turnId ? { ...bet, baseline } : bet))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    await noteWorktreeFiles($)
    const bet = await read($, open)
    const isThisTurn = bet.turnId === e.turnId
    const files = isThisTurn ? bet.files.length : 0
    const ask = isThisTurn ? shortAsk(bet.ask) : ''
    const dim = isThisTurn ? bet.bonusDim : undefined
    const actualFor = (value: number) => (dim === undefined ? undefined : bonusBucketOf(dim, value))
    const bonusActual = isThisTurn
      ? actualFor(dim === 'duration' ? e.durationMs : dim === 'files' ? files : bet.toolCalls)
      : undefined
    const record: TurnRecord = {
      turnId: e.turnId,
      at: await $.clock.now(),
      durationMs: e.durationMs,
      files,
      filesBucket: bucketOf(files),
      toolCalls: isThisTurn ? bet.toolCalls : 0,
      isAborted: e.isAborted,
      ...(ask === '' ? {} : { ask }),
      ...(isThisTurn && bet.saidConfidence !== undefined
        ? { saidConfidence: bet.saidConfidence }
        : {}),
      ...(isThisTurn && bet.saidFiles !== undefined ? { saidFiles: bet.saidFiles } : {}),
      ...(dim === undefined ? {} : { bonusDim: dim }),
      ...(isThisTurn && bet.saidBonus !== undefined ? { saidBonus: bet.saidBonus } : {}),
      ...(bonusActual === undefined ? {} : { bonusActual }),
    }
    const before = await loadTurns($)
    const after = keepRecord(before, record)
    await saveTurns($, after)
    await noteBadges($, before, after)

    // The daily challenge, like the bonus question, needs no human verdict:
    // it is scored the moment the turn lands, against the threshold its own
    // history stood at before this turn (the very history `before` already is).
    const challengeDim = isThisTurn ? bet.dailyChallengeDim : undefined
    if (challengeDim !== undefined && !e.isAborted) {
      const challengeToday = localDateKey(await $.clock.now())
      const threshold = challengeThreshold(before, challengeDim)
      const value = challengeDim === 'duration' ? e.durationMs : challengeDim === 'files' ? files : bet.toolCalls
      const actual = dailyOutcome(value, threshold)
      const guess = bet.saidDailyChallenge
      const dailyLog = await loadDailyChallenges($)
      if (bet.isDailyChallengeDeclined === true) {
        await saveDailyChallenges(
          $,
          keepDailyChallenge(dailyLog, { date: challengeToday, dim: challengeDim, isSkipped: true }),
        )
      } else if (guess !== undefined) {
        await saveDailyChallenges(
          $,
          keepDailyChallenge(dailyLog, {
            date: challengeToday,
            dim: challengeDim,
            guess,
            actual,
            correct: guess === actual,
          }),
        )
      } else {
        // Offered, but the turn landed before it was answered or declined.
        // Still needs a record for today, else the identical question comes
        // back on the next turn — just not a scored one, and not one that
        // costs the streak.
        await saveDailyChallenges(
          $,
          keepDailyChallenge(dailyLog, { date: challengeToday, dim: challengeDim, isNotTaken: true }),
        )
      }
    }

    await update($, busy, () => false)
    await showStatus($)

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The band is where betting lives.
   *
   * It sits where the person is already looking while they wait, it costs no
   * pane, and a bare digit typed into an empty composer answers its buttons —
   * so a forecast is one keystroke with no focus to manage. Only ever one
   * question at a time, so the digits always mean the obvious thing.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey of the engine's own owns the band while it is up.
    if (e.props.hasSurvey) return next(e)

    const bet = await read($, open)
    await read($, revision)
    const { Box, Text, Button } = $.ui.resolve(e)
    const room = askRoomFor(e.props.bodyColumns)
    // Names the row, so a question that appears above the prompt says whose it is.
    const tag = (
      <Text backgroundColor="claude" color="inverseText" weight="bold">
        {' bet '}
      </Text>
    )

    if (e.props.isWorking && bet.turnId !== '' && bet.isDeclined !== true) {
      const said = bet.saidConfidence
      const quoted = shortAsk(bet.ask, room)

      // The question and its answers sit on separate lines: on one line, a
      // pane docked beside the transcript narrowed the band until the question
      // wrapped around its own buttons.
      if (said === undefined) {
        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {tag} Will{' '}
              {quoted !== '' && <Text dimColor>"{quoted}" </Text>}
              land first try?
            </Text>
            <Box gap={2}>
              {BANDS.map((band, at) => (
                <Button
                  key={`p${Math.round(band * 100)}`}
                  hotkey={String(at + 1)}
                  plain
                  onPress={() => placeConfidence($, band)}
                >
                  {asPercent(band)}
                </Button>
              ))}
              <Button key="decline" hotkey="0" plain dimColor onPress={() => declineBet($)}>
                Skip
              </Button>
            </Box>
          </Box>
        )
      }

      if (bet.saidFiles === undefined) {
        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {tag} <Text dimColor>you said {asPercent(said)} · </Text>how many files will it touch?
            </Text>
            <Box gap={2}>
              {FILE_BUCKETS.map((bucket, at) => (
                <Button
                  key={`f${bucket}`}
                  hotkey={String(at + 1)}
                  plain
                  onPress={() => placeFiles($, bucket)}
                >
                  {FILE_LABELS[bucket]}
                </Button>
              ))}
              <Button key="decline" hotkey="0" plain dimColor onPress={() => declineBet($)}>
                Skip
              </Button>
            </Box>
          </Box>
        )
      }

      // One rotating bonus question, its own skip: passing on it costs
      // nothing, and says nothing about the confidence or files bets already
      // placed this turn.
      if (bet.bonusDim !== undefined && bet.saidBonus === undefined && bet.isBonusDeclined !== true) {
        const dim = bet.bonusDim
        const buckets = BONUS_BUCKETS[dim]

        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {tag} Bonus: {BONUS_QUESTIONS[dim]}
            </Text>
            <Box gap={2}>
              {buckets.map((bucket, at) => (
                <Button key={`b${bucket}`} hotkey={String(at + 1)} plain onPress={() => placeBonus($, bucket)}>
                  {bonusLabel(dim, bucket)}
                </Button>
              ))}
              <Button key="decline" hotkey="0" plain dimColor onPress={() => declineBonus($)}>
                Skip
              </Button>
            </Box>
          </Box>
        )
      }

      // The daily challenge, its own skip: one optional yes/no about this
      // turn against the person's own median, offered at most once a day.
      if (
        bet.dailyChallengeDim !== undefined &&
        bet.saidDailyChallenge === undefined &&
        bet.isDailyChallengeDeclined !== true
      ) {
        const dim = bet.dailyChallengeDim
        // The same history `challengeThreshold` scores this turn's challenge
        // against at turn.complete: no new turn lands while this is showing,
        // so reading it fresh here can never drift from what it is judged by.
        const question = challengeQuestion(await loadTurns($), dim)

        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              {tag} Daily challenge: will this turn {question}
            </Text>
            <Box gap={2}>
              <Button key="yes" hotkey="1" plain onPress={() => placeDailyChallenge($, 'yes')}>
                Yes
              </Button>
              <Button key="no" hotkey="2" plain onPress={() => placeDailyChallenge($, 'no')}>
                No
              </Button>
              <Button key="decline" hotkey="0" plain dimColor onPress={() => declineDailyChallenge($)}>
                Skip
              </Button>
            </Box>
          </Box>
        )
      }

      const isOver =
        FILE_BUCKETS.indexOf(bucketOf(bet.files.length)) > FILE_BUCKETS.indexOf(bet.saidFiles)

      // A bet in play is background: quiet, with only the tag in color and the
      // count turning warning-colored once it runs past what was called.
      return (
        <Text wrap="truncate-end">
          <Text color="claude" weight="bold">
            bet
          </Text>
          <Text dimColor>
            {' '}
            {asPercent(said)} · {filesPhrase(bet.saidFiles)} ·{' '}
          </Text>
          <Text dimColor={!isOver} color={isOver ? 'warning' : undefined}>
            {bet.files.length} written so far
          </Text>
        </Text>
      )
    }

    const owed = owedVerdict(await loadTurns($))
    const badgeLine = await read($, badgeNote)
    if (!owed) {
      const last = await read($, lastVerdict)
      if (!last && !badgeLine) return next(e)

      const label = last && (last.result === 'landed' ? 'Landed' : last.result === 'fixed' ? 'Needed fixing' : 'Skipped')

      return (
        <Box flexDirection="column" gap={1}>
          {last && (
            <Box gap={1}>
              <Text>
                <Text dimColor>Recorded: </Text>
                <Text
                  color={last.result === 'landed' ? 'success' : last.result === 'fixed' ? 'warning' : undefined}
                  dimColor={last.result === 'skipped'}
                >
                  {label}
                </Text>
              </Text>
              <Button key="undo" hotkey="u" plain dimColor onPress={() => undoLastVerdict($)}>
                Undo
              </Button>
            </Box>
          )}
          {last?.rankUp && (
            <Text color="success" weight="bold">
              Rank up: {last.rankUp.from} → {last.rankUp.to}
            </Text>
          )}
          {badgeLine && <Text dimColor>{badgeLine}</Text>}
        </Box>
      )
    }

    // The question leads and the quote trails, so a narrow band cuts the
    // quote and never the question: "Did it…" was the first thing to go.
    const quoted = owed.ask === undefined ? '' : shortAsk(owed.ask, askRoomFor(e.props.bodyColumns, VERDICT_CHROME))

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {tag} <Text weight="bold">Did it land?</Text>{' '}
          <Text dimColor>
            you said {asPercent(owed.saidConfidence ?? 0)}
            {quoted === '' ? '' : ` · "${quoted}"`}
          </Text>
        </Text>
        <Box gap={2}>
          <Button key="landed" hotkey="1" plain onPress={() => giveVerdict($, owed.turnId, true)}>
            <Text color="success">Landed</Text>
          </Button>
          <Button key="fixed" hotkey="2" plain onPress={() => giveVerdict($, owed.turnId, false)}>
            <Text color="warning">Needed fixing</Text>
          </Button>
          <Button key="skip" hotkey="0" plain dimColor onPress={() => waveVerdict($, owed.turnId)}>
            Skip
          </Button>
        </Box>
        {badgeLine && <Text dimColor>{badgeLine}</Text>}
      </Box>
    )
  })

  // The pane is the record: what the band collects, read back. /bet opens it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, revision)
    const found = report(await loadTurns($))
    const last = await read($, lastVerdict)
    const width = Math.max(20, e.props.bodyColumns)
    const tag = (
      <Text backgroundColor="claude" color="inverseText" weight="bold">
        {' bet-on-your-agent '}
      </Text>
    )
    // The rank sits right beside the plugin's own tag, so it is the first
    // thing read whether the pane is calibrating, scored, or empty.
    const header = (
      <Box gap={1}>
        {tag}
        <Text dimColor>{found.rank}</Text>
      </Box>
    )
    const rankUp = last?.rankUp && (
      <Text color="success" weight="bold">
        Rank up: {last.rankUp.from} → {last.rankUp.to}
      </Text>
    )
    // Six badges, earned or locked, always the full set beside the record —
    // the wall never changes shape whether the pane is calibrating or empty.
    const badgeWall = (
      <Box flexDirection="column">
        <Text dimColor>Badges</Text>
        <Text wrap="truncate-end">
          {found.badges.map((badge, i) => (
            <Text key={badge.id}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text color={badge.earned ? 'success' : undefined} dimColor={!badge.earned}>
                {badgeValue(badge)} {badge.name}
              </Text>
            </Text>
          ))}
        </Text>
      </Box>
    )

    if (found.brier === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box flexDirection="column">
            <Text weight="bold">
              {found.recorded === 0 ? 'No turns yet.' : `${found.recorded} turns recorded, none scored yet.`}
            </Text>
            <Text dimColor>
              While Claude works, the row above the prompt asks how the turn will go: a digit from 1 to 5
              answers. When it lands, say whether it landed. Five calls in, this shows how well you call it.
            </Text>
            {found.files && (
              <Text dimColor>
                files called {found.files.right}/{found.files.of}
              </Text>
            )}
            {found.bonus && (
              <Text dimColor>
                Bonus: {found.bonus.right}/{found.bonus.of} correct
              </Text>
            )}
          </Box>
          {rankUp}
          {badgeWall}
        </Box>
      )
    }

    const calibrating = isCalibrating(found)
    const leanColor = (lean: 'over' | 'under' | 'fair' | undefined) =>
      lean === 'over' ? 'warning' : lean === 'under' ? 'subtle' : 'success'
    const rows = Math.max(2, (e.viewport?.rows ?? 24) - 16)

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {rankUp}

        {calibrating ? (
          <Box flexDirection="column">
            <Text weight="bold">
              Calibrating{' '}
              <Text color="claude">
                {'●'.repeat(found.scored)}
                <Text dimColor>{'○'.repeat(MIN_SCORED - found.scored)}</Text>
              </Text>{' '}
              <Text dimColor>
                {found.scored} of {MIN_SCORED} calls
              </Text>
            </Text>
            <Text dimColor>The score means something from {MIN_SCORED}. Until then, here is what there is.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text weight="bold" color={leanColor(found.lean)}>
              {headline(found)}
            </Text>
            <Text dimColor>
              Brier {found.brier.toFixed(3)} over {found.scored} turns ·{' '}
              {found.brier < COIN_FLIP_BRIER ? 'better than a coin flip' : 'no better than a coin flip'}
            </Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor tabular>
            {CALIBRATION_HEAD}
          </Text>
          {found.rows.slice(0, rows).map(row => (
            <Text
              key={`row${Math.round(row.said * 100)}`}
              tabular
              color={calibrating ? undefined : leanColor(row.lean)}
              dimColor={calibrating}
            >
              {calibrationLine(row)}
            </Text>
          ))}
        </Box>

        {found.misses.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Worst calls</Text>
            {groupMisses(found.misses).map(({ miss, count }) => (
              <Text key={`miss${miss.ask ?? ''}${miss.said}${miss.landed}`} wrap="truncate-end">
                <Text tabular>{asPercent(miss.said).padStart(4)}</Text>{' '}
                <Text color={miss.landed ? 'success' : 'warning'}>{miss.landed ? 'landed' : 'missed'}</Text>
                {count > 1 && <Text dimColor> ×{count}</Text>}
                <Text dimColor>
                  {'  '}
                  {shortAsk(miss.ask ?? 'a turn with no prompt', width)}
                </Text>
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          {found.files !== undefined && (
            <Text dimColor>File count called right {found.files.right}/{found.files.of}.</Text>
          )}
          {found.bonus !== undefined && (
            <Text dimColor>Bonus: {found.bonus.right}/{found.bonus.of} correct.</Text>
          )}
          {found.landed !== undefined && (
            <Text dimColor>
              Lands first try {asPercent(found.landed.yes / found.landed.of)} ({found.landed.yes}/{found.landed.of}).
            </Text>
          )}
          {found.medianMs !== undefined && <Text dimColor>Median turn {asDuration(found.medianMs)}.</Text>}
        </Box>

        {badgeWall}
      </Box>
    )
  })
}
