import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { BonusBucket, DailyChallengeRecord, DailyGuess, FileBucket, LastVerdict, OpenBet, TurnRecord } from '../types'
import {
  asDuration,
  askRoomFor,
  asPercent,
  asText,
  badges,
  badgeValue,
  BANDS,
  betYields,
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
  drawnBy,
  extrasFromFor,
  extrasIn,
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
  statusHeadline,
  undoVerdict,
  VERDICT_CHROME,
} from './bet'

const PANE = 'bet-on-your-agent'
const STORE_KEY = 'turns'
const DAILY_CHALLENGE_STORE_KEY = 'dailyChallenges'
/** The local day, `YYYY-MM-DD`, from which the extras surface on their own. */
const EXTRAS_FROM_STORE_KEY = 'extrasFrom'

const NO_BET: OpenBet = { turnId: '', ask: '', files: [], toolCalls: 0 }

const open = atom({ plugin: 'bet-on-your-agent', key: 'open' } as const, NO_BET)
const busy = atom({ plugin: 'bet-on-your-agent', key: 'busy' } as const, false)
const lastVerdict = atom(
  { plugin: 'bet-on-your-agent', key: 'lastVerdict' } as const,
  null as LastVerdict | null,
)
const revision = atom({ plugin: 'bet-on-your-agent', key: 'revision' } as const, 0)
/**
 * The last history a read actually returned.
 *
 * A later read that fails would otherwise draw an empty record, which looks
 * like the rank and the score were wiped. Null until a read has succeeded.
 */
const lastGoodTurns = atom(
  { plugin: 'bet-on-your-agent', key: 'lastGoodTurns' } as const,
  null as TurnRecord[] | null,
)
/**
 * The same history, held in the process.
 *
 * A drawing may not write plugin state, so the copy above is updated from a
 * turn or a status refresh. This one is what the next draw uses when the
 * read fails before that refresh has run.
 */
let seenTurns: TurnRecord[] | undefined
/** A stored history that is not a list has been noted. Once, for the life of the process. */
let notedBadHistory = false
/** The most recent "Badge earned" note, shown once beside the band's own scoring output. */
const badgeNote = atom({ plugin: 'bet-on-your-agent', key: 'badgeNote' } as const, null as string | null)
/** How many turns have offered a bonus question so far; drives the rotation. */
const bonusRotation = atom({ plugin: 'bet-on-your-agent', key: 'bonusRotation' } as const, 0)
/** When this session began, for the recap card's "this session" when it has no id. */
const sessionStartedAt = atom(
  { plugin: 'bet-on-your-agent', key: 'sessionStartedAt' } as const,
  null as number | null,
)

/**
 * The id of the session now running, or undefined when the host has none.
 *
 * A throw is the same as none: the recap then falls back to the start time,
 * and a turn is recorded without an id rather than not recorded.
 */
const sessionIdOf = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const id = await $.session.id()

    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

type Config = { autoOpen: boolean }

/** Stable enough to tell two histories apart without caring about key order. */
const turnStamp = (one: TurnRecord): string =>
  [
    one.turnId,
    one.at,
    one.durationMs,
    one.files,
    one.filesBucket,
    one.toolCalls,
    one.isAborted ? 1 : 0,
    one.ask ?? '',
    one.saidConfidence ?? '',
    one.saidFiles ?? '',
    one.landed === undefined ? '' : one.landed ? 1 : 0,
    one.isVerdictSkipped === true ? 1 : 0,
    one.bonusDim ?? '',
    one.saidBonus ?? '',
    one.bonusActual ?? '',
    one.filesUnknown === true ? 1 : 0,
    one.sessionId ?? '',
  ].join('\u001f')

const sameHistory = (left: readonly TurnRecord[], right: readonly TurnRecord[]): boolean => {
  if (left.length !== right.length) return false
  for (let at = 0; at < left.length; at++) {
    const prev = left[at]
    const next = right[at]
    if (prev === undefined || next === undefined || turnStamp(prev) !== turnStamp(next)) return false
  }

  return true
}

/** Keeps the last history a read or a write actually produced, for a later read that fails. */
const rememberTurns = async ($: EngineInterface, records: readonly TurnRecord[]) => {
  const cached = await read($, lastGoodTurns)
  if (cached !== null && sameHistory(cached, records)) return
  await update($, lastGoodTurns, () => records.map(one => ({ ...one })))
}

/**
 * The stored history.
 *
 * `undefined` means the read failed, or the store holds a value that is not
 * a list. A missing key is no data yet (`[]`). A caller that writes has to
 * skip the write on `undefined`: saving the one record just built from `[]`,
 * or over a value that is not a list, would replace what the store still holds.
 */
const loadTurns = async ($: EngineInterface): Promise<TurnRecord[] | undefined> => {
  const stored = await $.store.get(STORE_KEY).then(
    value => ({ value }),
    () => undefined,
  )
  if (stored === undefined) return undefined
  // A missing key is no data yet. Anything else that is not a list is left
  // where it is: returning [] here is what used to overwrite it.
  if (!Array.isArray(stored.value)) {
    if (stored.value === undefined) {
      seenTurns = []

      return []
    }
    if (!notedBadHistory) {
      notedBadHistory = true
      $.ui.log("couldn't read the saved history")
    }

    return undefined
  }
  const records = stored.value as TurnRecord[]
  seenTurns = records

  return records
}

/** The history to draw. A failed read keeps the last one that loaded, instead of an empty record. */
const turnsToShow = async ($: EngineInterface): Promise<TurnRecord[]> => {
  const loaded = await loadTurns($)
  if (loaded !== undefined) return loaded
  if (seenTurns !== undefined) return seenTurns

  return (await read($, lastGoodTurns)) ?? []
}

/**
 * Writes the history and bumps `revision`.
 *
 * A `$.store` read does not subscribe a drawing, so without the bump the band
 * and pane would keep showing the history as it stood when last drawn.
 */
const saveTurns = async ($: EngineInterface, records: readonly TurnRecord[]) => {
  await $.store.set(STORE_KEY, records)
  await rememberTurns($, records)
  await update($, revision, at => at + 1)
}

/**
 * The daily-challenge log.
 *
 * `undefined` means the read failed. A missing key, and a value that is not
 * a list, are both no data yet (`[]`). A caller that writes has to skip the
 * write on `undefined`: saving today's result from `[]` would replace the
 * streak the store still holds.
 */
const loadDailyChallenges = async ($: EngineInterface): Promise<DailyChallengeRecord[] | undefined> => {
  const read = await $.store.get(DAILY_CHALLENGE_STORE_KEY).then(
    value => ({ value }),
    () => undefined,
  )
  if (read === undefined) return undefined

  return Array.isArray(read.value) ? (read.value as DailyChallengeRecord[]) : []
}

const saveDailyChallenges = async ($: EngineInterface, records: readonly DailyChallengeRecord[]) => {
  await $.store.set(DAILY_CHALLENGE_STORE_KEY, records)
  await update($, revision, at => at + 1)
}

/** The day the extras surface on their own, or undefined while it was never fixed. */
const loadExtrasFrom = async ($: EngineInterface): Promise<string | undefined> => {
  const raw = await $.store.get(EXTRAS_FROM_STORE_KEY).catch(() => undefined)

  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}

/**
 * Fixes, once, the day the bonus question, the daily challenge and the badge
 * wall start surfacing on their own: a week out for someone new, today for
 * anyone with a record already, read off this machine's own clock.
 *
 * Left unfixed when the history cannot be read, so a failed read never holds
 * back what an existing record already had.
 */
const fixExtrasFrom = async ($: EngineInterface) => {
  if ((await loadExtrasFrom($)) !== undefined) return
  const history = await $.store.get(STORE_KEY).then(
    value => ({ value }),
    () => undefined,
  )
  if (history === undefined) return
  const hasHistory = Array.isArray(history.value) && history.value.length > 0
  await $.store.set(EXTRAS_FROM_STORE_KEY, extrasFromFor(hasHistory, localDateKey(await $.clock.now())))
}

/**
 * Days left in a new person's first week; 0 once the extras surface on their
 * own, and 0 whenever the day or the clock cannot be read — the record and
 * the pane never fail, nor hold anything back, over this.
 */
const extrasWait = async ($: EngineInterface): Promise<number> => {
  const from = await loadExtrasFrom($)
  if (from === undefined) return 0
  const now = await $.clock.now().catch(() => undefined)

  return now === undefined ? 0 : extrasIn(from, localDateKey(now))
}

/**
 * Compares the badge wall before and after a write, and names whatever is
 * newly earned in one quiet note — the badges computed here need no fact
 * beyond what `before`/`after` already carry.
 *
 * Not through a new person's first week: the wall waits in `/bet-recap`
 * then, and a badge earned meanwhile is there to be found.
 */
const noteBadges = async ($: EngineInterface, before: readonly TurnRecord[], after: readonly TurnRecord[]) => {
  if ((await extrasWait($)) > 0) return
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
    const records = await loadTurns($)
    // Unreadable history is not an empty one. Clear the line: a turn that
    // could not be recorded must not leave the running-turn prompt up, and
    // must not ask about a verdict this read never saw.
    if (records === undefined) {
      $.ui.status(undefined)

      return
    }
    // Not from a drawing: a render may not write state, and this is what
    // keeps the last good history for the next one that fails.
    await rememberTurns($, records)
    const found = report(records)
    if (found.owed > 0) {
      $.ui.status(`did it land? ${found.owed === 1 ? '1 to answer' : `${found.owed} to answer`}`)

      return
    }
    $.ui.status(found.brier === undefined ? undefined : statusHeadline(found))
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
  if (before === undefined) return
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
  const records = await loadTurns($)
  if (records === undefined) return
  await saveTurns($, skipVerdict(records, turnId))
  await update($, lastVerdict, () => ({ turnId, result: 'skipped' }))
  await showStatus($)
}

/** Lets go of the verdicts too old to answer, so a session never opens on one. */
const lapseStaleVerdicts = async ($: EngineInterface) => {
  const records = await loadTurns($)
  if (records === undefined) return
  const kept = lapseVerdicts(records, await $.clock.now())
  if (kept !== records) await saveTurns($, kept)
}

/** Puts the last verdict back to owed, so misreading it costs one press, not a wrong score. */
const undoLastVerdict = async ($: EngineInterface) => {
  const last = await read($, lastVerdict)
  if (!last) return
  const records = await loadTurns($)
  if (records === undefined) return
  await saveTurns($, undoVerdict(records, last.turnId))
  await update($, lastVerdict, () => null)
  await showStatus($)
}

const noteFile = async ($: EngineInterface, path: string | undefined) => {
  if (path === undefined || path === '') return
  await update($, open, bet =>
    bet.files.includes(path) ? bet : { ...bet, files: [...bet.files, path].slice(-WORKTREE_LIMIT) },
  )
}

/**
 * Counts one tool call on the open main turn, whichever tool and whether or
 * not it was denied — the bonus question asks "how many", not "how many that
 * ran". The caller leaves out a call that carries an agentId: that call is a
 * subagent's, not this turn's.
 */
const noteToolCall = async ($: EngineInterface) => {
  await update($, open, bet => ({ ...bet, toolCalls: bet.toolCalls + 1 }))
}

/**
 * Past this many changed paths, a look at the working tree is not a count.
 *
 * Giving up used to look the same as a clean tree, and the turn was scored
 * as having written nothing.
 */
const WORKTREE_LIMIT = 500

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** Hashes git returned, and paths a call did not answer for. */
type PresentHashes = { hashes: Map<string, string>; unread: Set<string> }

const hashesOf = (paths: readonly string[], stdout: string) => {
  const lines = stdout.split('\n')

  return new Map(paths.map((path, at) => [path, lines[at] ?? '']))
}

/**
 * Isolates paths git refuses without one `hash-object` per file.
 *
 * A call that does not answer marks its paths unread and stops. Splitting it
 * would wait out the timeout again for each half.
 */
const hashSplit = async (
  $: EngineInterface,
  root: string,
  paths: readonly string[],
  hashes: Map<string, string>,
  unread: Set<string>,
): Promise<boolean> => {
  if (paths.length === 0) return false
  const ran = await runGit($, ['hash-object', '--', ...paths], root)
  if (ran === undefined) {
    for (const path of paths) unread.add(path)

    return true
  }
  if (ran.exitCode === 0) {
    for (const [path, hash] of hashesOf(paths, ran.stdout)) hashes.set(path, hash)

    return true
  }
  if (paths.length === 1) return true
  const mid = Math.ceil(paths.length / 2)
  const [left, right] = await Promise.all([
    hashSplit($, root, paths.slice(0, mid), hashes, unread),
    hashSplit($, root, paths.slice(mid), hashes, unread),
  ])

  return left || right
}

/**
 * Content hashes for the paths still in the tree.
 *
 * One `hash-object` covers the lot. When any path in that call cannot be
 * hashed — a nested repository, a worktree — git exits non-zero for the
 * whole call, so the list is split until the path git refuses is left out.
 * A call that does not answer leaves those paths unread. Undefined only when
 * the whole look gets no answer at all.
 */
const hashPresent = async (
  $: EngineInterface,
  root: string,
  present: readonly string[],
): Promise<PresentHashes | undefined> => {
  if (present.length === 0) return { hashes: new Map(), unread: new Set() }
  const all = await runGit($, ['hash-object', '--', ...present], root)
  if (all === undefined) return undefined
  if (all.exitCode === 0) return { hashes: hashesOf(present, all.stdout), unread: new Set() }
  if (present.length === 1) return { hashes: new Map(), unread: new Set() }
  const hashes = new Map<string, string>()
  const unread = new Set<string>()
  const mid = Math.ceil(present.length / 2)
  const [left, right] = await Promise.all([
    hashSplit($, root, present.slice(0, mid), hashes, unread),
    hashSplit($, root, present.slice(mid), hashes, unread),
  ])
  if (!left && !right && hashes.size === 0 && unread.size === 0) return undefined

  return { hashes, unread }
}

/**
 * Each file git sees changed in the repository, as path to content hash.
 *
 * Undefined outside a repository, or when git does not answer; the tool calls
 * are then the only count there is. `'untrusted'` when `git status` lists more
 * paths than `WORKTREE_LIMIT` — changed or untracked, not only this turn's.
 * A first look that returns that is no baseline, and the tool calls are the
 * count. A later look, against a baseline already taken, means the count can
 * no longer be read. `kept` is that baseline: a path whose hash did not come
 * back keeps it, so a timeout is not counted as a write.
 */
const lookAtWorktree = async (
  $: EngineInterface,
  kept?: Readonly<Record<string, string>>,
): Promise<Record<string, string> | 'untrusted' | undefined> => {
  const top = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = top?.exitCode === 0 ? top.stdout.trim() : ''
  if (root === '') return undefined
  const status = await runGit($, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
  if (status?.exitCode !== 0) return undefined
  const entries = parseStatus(status.stdout)
  if (entries.length > WORKTREE_LIMIT) return 'untrusted'
  const present = entries.filter(one => !one.isDeleted).map(one => one.path)
  const hashed = await hashPresent($, root, present)
  if (hashed === undefined) return undefined
  const look: Record<string, string> = {}
  for (const one of entries) {
    const full = `${root}/${one.path}`
    if (one.isDeleted) {
      look[full] = 'deleted'
      continue
    }
    const hash = hashed.hashes.get(one.path)
    if (hash !== undefined) {
      look[full] = hash
      continue
    }
    // No answer for this path. Dropping it would look like the file was
    // changed back. Keep the hash from the turn's baseline when there is one.
    const keptHash = kept?.[full]
    if (hashed.unread.has(one.path) && typeof keptHash === 'string') look[full] = keptHash
  }

  return look
}

/**
 * Counts every file whose content moved since the turn started, however it
 * was written: a shell heredoc or a script makes no Edit call.
 *
 * A later look that gives up marks the count unknown. It does not leave the
 * number where it stood, which is zero whenever the writes came through the
 * shell. A turn that never got a baseline is left to the tool calls.
 */
const noteWorktreeFiles = async ($: EngineInterface) => {
  const { baseline, filesUnknown } = await read($, open)
  if (filesUnknown === true || baseline === undefined) return
  const now = await lookAtWorktree($, baseline)
  if (now === 'untrusted') {
    await update($, open, bet => ({ ...bet, filesUnknown: true as const }))

    return
  }
  if (now === undefined) return
  const moved = changedSince(baseline, now)
  await update($, open, bet => {
    const added = moved.filter(path => !bet.files.includes(path))

    return added.length === 0 ? bet : { ...bet, files: [...bet.files, ...added].slice(-WORKTREE_LIMIT) }
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
    await fixExtrasFrom($)
    await lapseStaleVerdicts($)
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bet' }, async $ => {
    void $.ui.open({ id: PANE, title: 'Bet on your agent' }).catch(() => undefined)
    const last = await read($, lastVerdict)

    return { text: asText(report(await turnsToShow($)), last?.rankUp, (await extrasWait($)) === 0) }
  })

  // Every extra is here from the first day, the badge wall included: in a new
  // person's first week this is where they are found rather than pushed.
  on('command.run', { command: 'bet-recap' }, async ($, e) => {
    const all = await turnsToShow($)
    const startedAt = await read($, sessionStartedAt)
    const sessionId = await sessionIdOf($)
    // Another window writes the same store. A record made after this session
    // began is not this session's; the id is what says whose it is.
    const session =
      sessionId === undefined
        ? startedAt === null
          ? all
          : all.filter(one => one.at >= startedAt)
        : all.filter(one => one.sessionId === sessionId)
    const dailyChallenges = (await loadDailyChallenges($)) ?? []
    const today = localDateKey(await $.clock.now())
    const recap = recapOf(session, all, dailyChallenges, today, await extrasWait($))

    // Sized to the terminal the card is printed in, so it keeps its frame there.
    return { text: recapCard(recap, e.presentation?.columns) }
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
  // A subagent's shell counts here too: the question is how many files the turn touches.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny) await noteWorktreeFiles($)

    return ran
  }).catch(($, e, next) => next(e))

  // Unfiltered: every tool the main turn calls, not only the ones the hooks
  // above already watch for files, is a tool call toward the bonus question.
  // A call with an agentId is a subagent's and stays off this turn's count.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) await noteToolCall($)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Through a new person's first week a turn asks the core questions alone:
    // will it land, and how many files.
    const isFirstWeek = (await extrasWait($)) > 0
    const dim = isFirstWeek ? undefined : bonusDimFor(await read($, bonusRotation))
    if (dim !== undefined) await update($, bonusRotation, at => at + 1)
    // Today's challenge, if today does not already have one: answered,
    // declined or left untouched, a day is handled and not offered again on
    // a later turn.
    const today = localDateKey(await $.clock.now())
    const dailyLog = await loadDailyChallenges($)
    // An unreadable log is not an empty one: offering today off `[]` would
    // ask again for a day the store may already have recorded.
    const dailyDim =
      !isFirstWeek && dailyLog !== undefined && challengeFor(dailyLog, today) === undefined
        ? dailyChallengeDimFor(today)
        : undefined
    // The betting window opens here and closes when the turn lands.
    await update($, open, () => ({
      turnId: e.turnId,
      ask: e.text,
      files: [],
      toolCalls: 0,
      ...(dim === undefined ? {} : { bonusDim: dim }),
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
    // A status list already past the limit is no baseline, same as outside a
    // repository: Edit, Write and NotebookEdit stay the count, and the file
    // question is still scored. Marking it unknown here would ask that
    // question on every turn and then throw the answer away.
    const baseline = await lookAtWorktree($)
    if (baseline !== undefined && baseline !== 'untrusted') {
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
    const filesUnknown = isThisTurn && bet.filesUnknown === true
    const files = isThisTurn && !filesUnknown ? bet.files.length : 0
    const ask = isThisTurn ? shortAsk(bet.ask) : ''
    const dim = isThisTurn ? bet.bonusDim : undefined
    // A files bonus graded against a stand-in zero would be a right or wrong
    // answer the turn never earned. The other dimensions do not use the count.
    const bonusActual =
      dim !== undefined && !(filesUnknown && dim === 'files')
        ? bonusBucketOf(dim, dim === 'duration' ? e.durationMs : dim === 'files' ? files : bet.toolCalls)
        : undefined
    const sessionId = await sessionIdOf($)
    const record: TurnRecord = {
      turnId: e.turnId,
      at: await $.clock.now(),
      durationMs: e.durationMs,
      files,
      filesBucket: bucketOf(files),
      ...(filesUnknown ? { filesUnknown: true as const } : {}),
      toolCalls: isThisTurn ? bet.toolCalls : 0,
      ...(sessionId === undefined ? {} : { sessionId }),
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
    // A failed read is not an empty history. Skip this turn's record — and
    // the challenge scored against that history — so the store is left as it
    // was. One line says the turn was not saved. The status line below still
    // moves off the running-turn prompt.
    if (before === undefined) $.ui.log("couldn't save that turn")
    if (before !== undefined) {
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
        // A failed read is not an empty log. Skip today's write so the streak
        // the store still holds is left where it is.
        if (dailyLog !== undefined) {
          if (bet.isDailyChallengeDeclined === true) {
            await saveDailyChallenges(
              $,
              keepDailyChallenge(dailyLog, { date: challengeToday, dim: challengeDim, isSkipped: true }),
            )
          } else if (guess !== undefined && challengeDim === 'files' && filesUnknown) {
            // Answered, but the count it was judged against is not a number. The
            // day is handled so it is not asked again; the answer is not scored.
            await saveDailyChallenges(
              $,
              keepDailyChallenge(dailyLog, { date: challengeToday, dim: challengeDim, guess, isUnmeasured: true }),
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

    /** This mod's own row, or undefined when it has nothing to ask or say. */
    const draw = async (): Promise<RenderElement | undefined> => {
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
          const question = challengeQuestion(await turnsToShow($), dim)

          // Wrapped, not cut: the question is fixed text with nothing to give
          // way, and cut at the band's edge it lost what it was asking.
          return (
            <Box flexDirection="column">
              <Text wrap="wrap">
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

        // No number, rather than 0: a snapshot that gave up is not a count, and
        // a 0 here would read as the call having been right.
        if (bet.filesUnknown === true) {
          return (
            <Text wrap="truncate-end">
              <Text color="claude" weight="bold">
                bet
              </Text>
              <Text dimColor>
                {' '}
                {asPercent(said)} · {filesPhrase(bet.saidFiles)} · file count unknown (500+ paths)
              </Text>
            </Text>
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

      const owed = owedVerdict(await turnsToShow($))
      const badgeLine = await read($, badgeNote)
      if (!owed) {
        const last = await read($, lastVerdict)
        if (!last && !badgeLine) return undefined

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
    }

    const mine = await draw()
    if (mine === undefined) return next(e)
    // The row is shared and shows one mod at a time: a breathe nudge already
    // beneath keeps it, and so does a turn-end diff card or a ship offer
    // between turns; the bet waits its turn there.
    const beneath = await next(e).catch(() => undefined)

    return beneath !== undefined && betYields(drawnBy(beneath), e.props.isWorking) ? beneath : mine
  })

  // The pane is the record: what the band collects, read back. /bet opens it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, revision)
    const found = report(await turnsToShow($))
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
    // Through a new person's first week it waits in /bet-recap instead.
    const badgeWall = (await extrasWait($)) === 0 && (
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
                File count called right {found.files.right}/{found.files.of}.
              </Text>
            )}
            {found.bonus && (
              <Text dimColor>
                Bonus: {found.bonus.right}/{found.bonus.of} correct.
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
