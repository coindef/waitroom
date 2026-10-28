import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Hunk, HunkStatus, Page, SessionStats } from '../types'
import type { Slice } from './diff'
import {
  DEFAULT_IGNORE,
  DIFF_COVER_HINT,
  EMPTY_SESSION,
  FOCUS_HINT,
  filledCells,
  isIgnored,
  linesThatFit,
  mergeHunks,
  nextHunk,
  paneHint,
  parseDiff,
  parseIgnore,
  progressOf,
  reviewable,
  reviewNote,
  sessionSummaryLine,
  sliceHunk,
  summaryOf,
  tally,
} from './diff'

const PANE = 'wait-review'

const hunks = atom({ plugin: 'wait-review', key: 'hunks' } as const, [] as Hunk[])
const busy = atom({ plugin: 'wait-review', key: 'busy' } as const, false)
const preexisting = atom({ plugin: 'wait-review', key: 'preexisting' } as const, [] as string[])
const base = atom({ plugin: 'wait-review', key: 'base' } as const, null as string | null)
/**
 * Whether `beginSession` has already run, including in a repository with no
 * commits yet. `base` cannot serve as that flag by itself: it stays `null`
 * forever in that repository, which reads the same as "never began".
 */
const began = atom({ plugin: 'wait-review', key: 'began' } as const, false)
/** Untracked, reviewable files the last scan found past `UNTRACKED_LIMIT`. */
const truncatedFiles = atom({ plugin: 'wait-review', key: 'truncatedFiles' } as const, 0)
const lastDecision = atom(
  { plugin: 'wait-review', key: 'lastDecision' } as const,
  null as Decision | null,
)
const noting = atom({ plugin: 'wait-review', key: 'noting' } as const, null as string | null)
const page = atom({ plugin: 'wait-review', key: 'page' } as const, null as Page | null)
/** This session's combo and grade inputs; reset once per true session start. */
const session = atom({ plugin: 'wait-review', key: 'session' } as const, EMPTY_SESSION as SessionStats)
/**
 * The first-run focus hint, dismissed for good. The store of the same fact
 * survives a new session; this atom is what a drawing reads.
 */
const focusHintDismissed = atom({ plugin: 'wait-review', key: 'focusHintDismissed' } as const, false)
/** `$.store` key for `focusHintDismissed`, so a new install sees the hint once. */
const FOCUS_HINT_KEY = 'focus-hint-dismissed'

/**
 * Rows the review card always spends around the diff: the header, the path
 * with its counts, the rule, the paging row, the controls, the keys hint and
 * the gaps between them. What only sometimes shows is added where it is drawn.
 */
const CHROME_ROWS = 9

/** The header's tag, the progress bar's cells, and the note shown while Claude works. */
const HEAD_TAG = ' wait-review '
const BAR_CELLS = 12
const BUSY_TEXT = 'Claude is working'
/**
 * Rows the note box takes around the hunk it shows: the header, the question,
 * the bordered field (three rows), its hint, the gaps between them, and a
 * "lines a–b of n" row when the hunk is cut.
 */
const NOTE_CHROME_ROWS = 10
/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
const UNTRACKED_LIMIT = 40
/** Hunk ids remembered as pre-session, enough for any working tree worth reading. */
const SNAPSHOT_LIMIT = 2000

type Config = {
  contextLines: number
  autoOpen: boolean
  attachFlags: boolean
  ignore: string[]
}

const whole = (value: unknown, fallback: number): number => {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

/**
 * The status line, which is a convenience: it never throws outward, because a
 * failure here would otherwise abort whatever hook was keeping it up to date.
 */
const showStatus = async ($: EngineInterface) => {
  try {
    const counts = tally(await read($, hunks))
    const parts: string[] = []
    if (counts.pending > 0) parts.push(`${counts.pending} to read`)
    // Nothing pending but something put off is not "done" - that would make
    // the status go quiet on exactly the hunks "later" exists to be reminded of.
    else if (counts.later > 0) parts.push(`${counts.later} put off`)
    if (counts.flagged > 0) parts.push(`${counts.flagged} flagged`)
    if (parts.length === 0) {
      $.ui.status(undefined)

      return
    }
    // Below 144 columns a pane nobody asked for is never placed, and a placed
    // one can be a tab behind another, so without this the count is the only
    // sign the mod is there. The tail is the one action that places it anyway:
    // `/wait-review`, which opens at any width.
    const panes = await $.ui.panes().catch(() => [])
    $.ui.status(`${parts.join(' · ')}${paneHint(panes.find(pane => pane.id === PANE))}`)
  } catch {
    // Nothing to do: the counts are still right, only unshown.
  }
}

/**
 * Whether the focus a pane was opened with arrives.
 *
 * It lands a moment after `$.ui.open` resolves - the pane list says unfocused
 * at once and focused some 100 to 400ms later, seen live on 2.1.304 - so a
 * single look raised a false "the diff panel is in front". Undefined where the
 * list does not name the pane at all.
 */
const focusArrives = async ($: EngineInterface): Promise<boolean | undefined> => {
  for (let look = 0; look < 6; look++) {
    const ours = (await $.ui.panes().catch(() => [])).find(pane => pane.id === PANE)
    if (ours === undefined) return undefined
    if (ours.isFocused) return true
    await $.clock.sleep(100)
  }

  return false
}

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * Every hunk in the repository right now, against the session's anchor.
 *
 * The whole diff rather than a list of files the agent was seen to touch: an
 * agent may write a file through any tool, and a shell heredoc leaves no Edit
 * call to watch. git is the only witness that cannot be fooled.
 */
type Scan = { hunks: Hunk[]; truncatedFiles: number }

const scanRepo = async ($: EngineInterface, config: Config): Promise<Scan> => {
  const root = await repoRoot($)
  if (root === undefined) return { hunks: [], truncatedFiles: 0 }

  const anchor = await read($, base)
  const unified = `--unified=${config.contextLines}`
  const found: Hunk[] = []

  // Against the session's own starting commit, so work the agent committed
  // mid-session is still waiting to be read.
  let diff =
    anchor === null
      ? undefined
      : await runGit($, ['diff', anchor, '--no-color', '--no-prefix', unified], root)
  // The anchor can stop resolving under a rebase or a reset; HEAD still does.
  if (!diff || diff.exitCode !== 0) {
    diff = await runGit($, ['diff', 'HEAD', '--no-color', '--no-prefix', unified], root)
  }
  // A repository with no commits yet has neither.
  if (!diff || diff.exitCode !== 0) {
    diff = await runGit($, ['diff', '--no-color', '--no-prefix', unified], root)
  }
  if (diff?.exitCode === 0) found.push(...parseDiff(diff.stdout))

  // A file the agent created is untracked: no blob on either side, so plain
  // `git diff` says nothing about it at all.
  const others = await runGit($, ['ls-files', '--others', '--exclude-standard'], root)
  const reviewableUntracked = (others?.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    // Ignored before the cap, not after: an untracked build folder nobody
    // reviews would otherwise spend the whole budget and starve out the
    // actual new source files the cap exists to make room for.
    .filter(path => !isIgnored(path, config.ignore))
  const untracked = reviewableUntracked.slice(0, UNTRACKED_LIMIT)
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit(
      $,
      ['diff', '--no-color', '--no-prefix', unified, '--no-index', '--', '/dev/null', path],
      root,
    )
    if (one && one.exitCode <= 1) found.push(...parseDiff(one.stdout))
  }

  return { hunks: found, truncatedFiles: reviewableUntracked.length - untracked.length }
}

/**
 * Takes the session's anchor and its snapshot of what was already dirty, once.
 *
 * Both together and both guarded, because `session.start` fires again on every
 * hot reload while `$.state` survives it: re-anchoring would move the base onto
 * a commit made since, and re-snapshotting would file the agent's own work as
 * pre-existing and empty the queue.
 */
const beginSession = async ($: EngineInterface, config: Config) => {
  if (await read($, began)) return
  await update($, began, () => true)

  const found = await runGit($, ['rev-parse', 'HEAD'])
  const sha = found?.exitCode === 0 ? found.stdout.trim() : ''
  // A repository with no commits yet has no sha to anchor to; `base` stays
  // null, which the diff falls back on, but the snapshot below must still be
  // taken, or every pre-existing untracked file is offered as the agent's own.
  if (sha !== '') await update($, base, () => sha)

  // What was uncommitted before the agent touched anything is the person's own
  // work in progress, not a review the agent owes them.
  const already = await scanRepo($, config)
  await update($, preexisting, () => already.hunks.map(one => one.id).slice(0, SNAPSHOT_LIMIT))
  // Guarded by the same `began` check above, so a hot reload mid-session
  // never zeroes out the combo and grade it was in the middle of building.
  await update($, session, () => EMPTY_SESSION)
}

/** Re-reads the repository and merges what it finds into the queue. */
const scan = async ($: EngineInterface, config: Config) => {
  const before = await read($, preexisting)
  const found = await scanRepo($, config)
  await update($, hunks, old => mergeHunks(old, reviewable(found.hunks, config.ignore, before)))
  await update($, truncatedFiles, () => found.truncatedFiles)
}

/**
 * `ok`, `flagged` and `later` are each a hunk individually read, as opposed
 * to one waved away in bulk by skipping its file — that distinction is what
 * the combo and the session grade are measuring.
 */
const noteRead = async ($: EngineInterface, status: HunkStatus) => {
  await update($, session, stats => {
    const combo = stats.combo + 1

    return {
      ...stats,
      read: stats.read + 1,
      flagged: status === 'flagged' ? stats.flagged + 1 : stats.flagged,
      combo,
      longestCombo: Math.max(stats.longestCombo, combo),
    }
  })
}

const mark = async ($: EngineInterface, id: string, status: HunkStatus) => {
  await update($, noting, () => null)
  const before = (await read($, hunks)).find(one => one.id === id)
  const fromSession = await read($, session)
  await update($, hunks, old => old.map(one => (one.id === id ? { ...one, status } : one)))
  await update($, lastDecision, () => (before ? { changes: [{ id, from: before.status }], fromSession } : null))
  await noteRead($, status)
  await showStatus($)
}

/** Moves the reader to `offset` lines into the hunk `id`. */
const turnPage = async ($: EngineInterface, id: string, offset: number) => {
  await update($, page, () => ({ id, offset: Math.max(0, offset) }))
}

/** Opens the note box for a hunk, or closes it when given nothing. */
const setNoting = async ($: EngineInterface, id: string | null) => {
  await update($, noting, () => id)
  // The Input's own `autoFocus` only wins when the site's ring starts fresh;
  // the click on "Say why" that got here already moved it there, so the ring
  // stays on that button unless told otherwise - land it on the box instead.
  if (id !== null) await $.ui.focus({ requestId: PANE, key: 'note-text' }).catch(() => undefined)
}

/**
 * Keeps what the person wrote about a flagged hunk and closes the box.
 *
 * An empty note is no note: pressing Enter on an empty box is how you decide
 * the diff speaks for itself.
 */
const saveNote = async ($: EngineInterface, id: string, text: string) => {
  const note = text.trim()
  await update($, hunks, old =>
    old.map(one => {
      if (one.id !== id) return one
      if (note === '') {
        const { note: _dropped, ...rest } = one

        return rest
      }

      return { ...one, note }
    }),
  )
  await update($, noting, () => null)
}

/** Puts the last call back, so misreading a hunk (or a whole file) costs one press, not a rescan. */
const undo = async ($: EngineInterface) => {
  const last = await read($, lastDecision)
  if (!last) return
  const from = new Map(last.changes.map(one => [one.id, one.from]))
  await update($, hunks, old =>
    old.map(one => (from.has(one.id) ? { ...one, status: from.get(one.id) as HunkStatus } : one)),
  )
  // The combo and the counts are part of the call being undone, same as the
  // hunks' statuses — not reverting them left a drop's "skipped" outliving
  // its own undo.
  await update($, session, () => last.fromSession)
  await update($, lastDecision, () => null)
  await showStatus($)
}

/**
 * Waves away everything still unread in one file.
 *
 * Dropped, not approved: a regenerated file is noise to clear, and the counts
 * should not pretend it was read. Undoable like any other call: it is the one
 * that touches the most hunks at once, so it is the one most worth a take-back.
 */
const dropFile = async ($: EngineInterface, path: string) => {
  const before = await read($, hunks)
  const changes = before
    .filter(one => one.path === path && (one.status === 'pending' || one.status === 'later'))
    .map(one => ({ id: one.id, from: one.status }))
  const ids = new Set(changes.map(one => one.id))
  const fromSession = await read($, session)
  await update($, hunks, old => old.map(one => (ids.has(one.id) ? { ...one, status: 'dropped' as const } : one)))
  await update($, lastDecision, () => (changes.length > 0 ? { changes, fromSession } : null))
  if (changes.length > 0) {
    // Waved away, not read: the combo breaks, whatever it was.
    await update($, session, stats => ({ ...stats, skipped: stats.skipped + changes.length, combo: 0 }))
  }
  await showStatus($)
}

/**
 * Copies the dismissed focus hint out of the store.
 *
 * A drawing reads the atom; the store is what makes "once" survive a new
 * session, `/clear`, and a resume. A missing store leaves the hint up.
 */
const loadFocusHint = async ($: EngineInterface) => {
  const saved = await $.store.get(FOCUS_HINT_KEY).catch(() => undefined)
  if (saved === true) await update($, focusHintDismissed, () => true)
}

/** The hint has done its job: `/wait-review`, or `o` / `f` while the pane held the keys. */
const dismissFocusHint = async ($: EngineInterface) => {
  if (await read($, focusHintDismissed)) return
  await update($, focusHintDismissed, () => true)
  await $.store.set(FOCUS_HINT_KEY, true).catch(() => undefined)
}

/**
 * Places the pane because the person asked, at any width, and gives it the keys.
 *
 * This is the one action the narrow-terminal status line names. Auto-open at
 * session start does not use it: that open leaves the keys with the composer.
 */
const openAsked = async ($: EngineInterface) => {
  await dismissFocusHint($)
  const opened = await $.ui
    .open({ id: PANE, title: 'Wait review', focus: true })
    .catch(() => ({ isPlaced: false, reason: 'the engine would not place it' }) as const)
  // Claude Code's own diff panel (2.1.304 on) holds the side of the
  // transcript while it is up, and the pane list still calls this pane
  // shown. What gives it away is the focus just asked for never arriving.
  const focused = opened.isPlaced ? await focusArrives($) : undefined

  return { opened, focused }
}

export const register: Register = (on, options) => {
  const config: Config = {
    contextLines: whole(options.contextLines, 3),
    autoOpen: options.autoOpen !== false,
    attachFlags: options.attachFlags !== false,
    ignore: parseIgnore(
      typeof options.ignore === 'string' && options.ignore.trim() !== ''
        ? options.ignore
        : DEFAULT_IGNORE,
    ),
  }

  on('session.start', async ($, e, next) => {
    // Taken before anything else here: the review is wrong without the anchor
    // and the snapshot, and neither is worth losing to a command registration.
    await beginSession($, config)
    await loadFocusHint($)
    // `immediate` so the status line's one action opens the pane during the
    // wait, not after the turn that wrote the diff has already ended.
    await $.command.register({
      name: 'wait-review',
      description: 'Open the wait-review pane and re-read the diff Claude has written so far',
      immediate: true,
    })
    // No `focus` here. A pane that opens by itself must not take the keys
    // before a first prompt has been sent; `/wait-review` does that.
    if (config.autoOpen) void $.ui.open({ id: PANE, title: 'Wait review' }).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  // `/clear`, `/resume` and `/branch` reset `$.state` and do not fire
  // `session.start`, so the hint would otherwise introduce itself again.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') await loadFocusHint($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The combo and the grade are a look back at the session, so they are said
  // once the reading is done and nowhere while it runs: a streak in the pane's
  // header is a score to play for, and the header is for the diff. The pane's
  // caught-up card shows the line; this one keeps it in the session's
  // transcript, where a resume finds it (at exit the screen closes over it).
  // A session that resolved nothing ends quietly, as a zero says nothing.
  on('session.end', async ($, e, next) => {
    const stats = await read($, session)
    if (stats.read > 0 || stats.skipped > 0) $.ui.log(sessionSummaryLine(stats))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'wait-review' }, async $ => {
    await scan($, config)
    await showStatus($)
    const counts = tally(await read($, hunks))
    // Focused only here, not on the autoOpen at session.start: typing `/wait-review`
    // is asking to use it now, where auto-opening at the start of a session is not -
    // stealing the composer's focus before a first prompt would eat its keystrokes.
    // The same open places the pane at any width, which is what a narrow
    // terminal's status line is promising.
    const { opened, focused } = await openAsked($)
    const where = !opened.isPlaced
      ? `Review pane waiting (${opened.reason}).`
      : focused === false
        ? DIFF_COVER_HINT
        : 'Review pane open.'
    const truncatedCount = await read($, truncatedFiles)
    const truncatedNote = truncatedCount > 0 ? ` +${truncatedCount} more files not shown.` : ''

    return {
      text: `${where} ${counts.pending} hunk${counts.pending === 1 ? '' : 's'} to read, ${counts.reviewed} reviewed, ${counts.flagged} flagged.${truncatedNote}`,
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, busy, () => true)
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // A subagent's edits are recorded by the tool hooks whatever loop they ran
    // in, and the main loop's own end scans them: scanning per subagent turn
    // would only spend git processes.
    if (e.agentId !== undefined) return done
    await update($, busy, () => false)
    await scan($, config)
    await showStatus($)

    return done
  }).catch(($, e, next) => next(e))

  // Flagged hunks ride along with the next thing the person sends, as context
  // the pane told them about before it went.
  on('prompt.submit', async ($, e, next) => {
    if (!config.attachFlags || e.command !== undefined) return next(e)
    const list = await read($, hunks)
    const flagged = list.filter(one => one.status === 'flagged')
    if (flagged.length === 0) return next(e)

    const done = await next({ ...e, context: [...(e.context ?? []), reviewNote(flagged)] })
    const ids = new Set(flagged.map(one => one.id))
    await update($, hunks, old =>
      old.map(one => (ids.has(one.id) ? { ...one, status: 'sent' as const } : one)),
    )
    await showStatus($)

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table
    // Which surfaces draw a field is declared by `Elements`, not discoverable
    // from the table: the runtime one carries every name and renders the ones
    // its surface does not know as a fragment. The mobile app draws none, so
    // the note is not offered there; this is the line to change when it does.
    const hasInput = e.surface !== 'mobile'
    const list = await read($, hunks)
    const isBusy = await read($, busy)
    const last = await read($, lastDecision)
    const noteFor = await read($, noting)
    const truncatedCount = await read($, truncatedFiles)
    const counts = tally(list)
    const current = nextHunk(list)
    // Only a single-hunk decision can be "the hunk just flagged" - a dropped
    // file is many hunks at once and none of them is an offer to say why.
    const flaggedId = last?.changes.length === 1 ? last.changes[0]?.id : undefined
    const flagged =
      flaggedId !== undefined && list.find(one => one.id === flaggedId)?.status === 'flagged'
        ? flaggedId
        : null
    const width = Math.max(20, e.props.bodyColumns)

    const summary = summaryOf(list)
    const decided = list.length - (counts.pending + counts.later)
    // A bar for the reading so far: a count says how many, the bar says how far.
    // The counts say more, so the bar only draws where they still fit beside it.
    const headRoom = HEAD_TAG.length + 1 + BAR_CELLS + 1 + summary.length + (isBusy ? 1 + BUSY_TEXT.length : 0)
    const barCells = width >= 56 && list.length > 0 && headRoom <= width ? BAR_CELLS : 0
    const filled = filledCells(decided, list.length, barCells)
    // Kept to the queue itself: the combo and the grade are said once the
    // reading is done (the caught-up card, and `session.end`), not while it runs.
    // The tag, the bar and the busy note keep their width; only the counts are
    // cut, so a narrow pane never splits " wait-review " across two lines.
    const head = (
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={1}>
          <Box gap={1}>
            <Box flexShrink={0}>
              <Text backgroundColor="suggestion" color="inverseText" weight="bold">
                {HEAD_TAG}
              </Text>
            </Box>
            {barCells > 0 && (
              // Same weight as the hunk separator below (─, not ━): the two
              // read as one family of rule, and color alone carries progress.
              <Box flexShrink={0}>
                <Text>
                  <Text color="success">{'─'.repeat(filled)}</Text>
                  <Text dimColor>{'─'.repeat(barCells - filled)}</Text>
                </Text>
              </Box>
            )}
            {summary !== '' && (
              <Text dimColor tabular wrap="truncate-end">
                {summary}
              </Text>
            )}
          </Box>
          {isBusy && (
            <Box flexShrink={0}>
              <Text color="claude">{BUSY_TEXT}</Text>
            </Box>
          )}
        </Box>
        {truncatedCount > 0 && <Text dimColor>+{truncatedCount} more files not shown</Text>}
      </Box>
    )

    const undoButton = last && (
      <Button key="undo" hotkey="u" plain dimColor onPress={() => undo($)}>
        Undo
      </Button>
    )

    // Offered wherever a flagged hunk is waiting on a reason, which includes an
    // emptied queue: flagging the last hunk is the commonest way to reach here,
    // and that is exactly when the reason still needs saying.
    const hasNote = flagged !== null && list.find(one => one.id === flagged)?.note !== undefined
    const noteOffer = flagged !== null && hasInput && (
      <Button key="note-open" hotkey="n" plain onPress={() => setNoting($, flagged)}>
        {hasNote ? 'Edit the reason' : 'Say why'}
      </Button>
    )
    // What is flagged and where it goes, set apart by a bar in the flag's
    // color, so the one thing that leaves this pane is never just another line.
    const flagCallout = counts.flagged > 0 && (
      <Box borderStyle="quote" borderColor="warning" paddingLeft={1} flexDirection="column">
        <Text>
          <Text color="warning" weight="bold">
            {counts.flagged} flagged
          </Text>
          <Text dimColor> · goes to Claude with your next message</Text>
        </Text>
        {noteOffer && <Box>{noteOffer}</Box>}
      </Box>
    )

    // The note box is a mode and does not depend on a card being up, so it is
    // answered before anything else.
    if (noteFor !== null && hasInput && 'Input' in table) {
      const { Input } = table
      const target = list.find(one => one.id === noteFor)
      // Flagging moves the card on, so without this the box asks why about a
      // hunk no longer on screen. It starts where the person was reading it.
      let context: Slice | undefined
      if (target !== undefined) {
        const height = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
        const reading = await read($, page)
        const offset = reading !== null && reading.id === target.id ? reading.offset : 0
        const gutter = String(target.start + target.added + target.removed + 1).length + 4
        const room = Math.max(3, height - NOTE_CHROME_ROWS)
        const fit = linesThatFit(target.text, offset, room, Math.max(10, width - gutter))
        context = sliceHunk(target.text, offset, fit)
      }

      return (
        <Box flexDirection="column" gap={1}>
          {head}
          <Box flexDirection="column">
            <Text wrap="truncate-start">
              <Text weight="bold">Why flag </Text>
              <Text weight="bold">{target?.path ?? 'that hunk'}</Text>
              {target !== undefined && <Text dimColor>:{target.start}</Text>}
              <Text weight="bold">?</Text>
            </Text>
            <Box borderStyle="round" borderColor="warning" paddingX={1}>
              <Input
                key="note-text"
                placeholder="e.g. this drops the retry on every 5xx"
                submitLabel="Attach"
                autoFocus
                onSubmit={value => saveNote($, noteFor, value)}
              />
            </Box>
            <Text dimColor wrap="truncate-end">
              Enter attaches it · an empty Enter sends the hunk without a reason
            </Text>
          </Box>
          {context && (
            <Box flexDirection="column">
              <Code source={context.text} format="diff" wrap="wrap" />
              {context.total > context.last - context.first && (
                <Text dimColor tabular>
                  lines {context.first + 1}–{context.last} of {context.total}
                </Text>
              )}
            </Box>
          )}
        </Box>
      )
    }

    // The auto-opened pane does not take the keys. Until the person has run
    // `/wait-review`, or pressed `o` or `f` while this pane held them, say so
    // once — bold, and only while it does not have the keys.
    const isFocused = e.props.isFocused
    const showFocusHint = !isFocused && !(await read($, focusHintDismissed))
    const focusHintLine = showFocusHint && (
      <Text weight="bold" wrap="truncate-end">
        {FOCUS_HINT}
      </Text>
    )

    if (!current) {
      const isFresh = counts.reviewed === 0 && counts.dropped === 0 && counts.flagged === 0
      // The reading is done for now, so its one line is said here: the line
      // `session.end` writes at exit lands in the transcript as the screen
      // closes, where nobody reads it, and shows only on a resume.
      const stats = await read($, session)
      const hasSessionActivity = stats.read > 0 || stats.skipped > 0
      // Written the way the live controls draw themselves (`o: Looks right`),
      // so the legend is the row the person meets one turn later, not a gloss.
      const key = (letter: string, does: string) => (
        <Text>
          <Text color="suggestion">{letter}:</Text> <Text dimColor>{does}</Text>
        </Text>
      )

      return (
        <Box flexDirection="column" gap={1}>
          {head}
          {isFresh ? (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="column">
                <Text weight="bold">Nothing to read yet.</Text>
                <Text dimColor>
                  {isBusy
                    ? 'Claude is working. Its first change lands here the moment it is written.'
                    : 'Each change Claude makes lands here, a hunk at a time, to read while it works.'}
                </Text>
              </Box>
              <Box columnGap={2} flexWrap="wrap">
                {key('o', 'Looks right')}
                {key('f', 'Flag')}
                {key('l', 'Later')}
                {key('x', 'Skip file')}
              </Box>
              {focusHintLine}
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color="success" weight="bold">
                ✓ All caught up
              </Text>
              <Text dimColor>
                {decided} {decided === 1 ? 'hunk' : 'hunks'} read
                {counts.flagged > 0 ? '' : ', nothing to send Claude'}. New changes land here as Claude
                makes them.
              </Text>
              {hasSessionActivity && <Text dimColor>{sessionSummaryLine(stats)}</Text>}
              {focusHintLine}
            </Box>
          )}
          {flagCallout}
          {undoButton && <Box>{undoButton}</Box>}
        </Box>
      )
    }

    const where = progressOf(list, current)
    // Hotkeys only land while the pane holds the keyboard; say how to give it
    // the keys, since pressing `o` without that types an o into the prompt.
    // The first time, one bold line: `/wait-review`, then `o` and `f`. After
    // that, the fuller reminder. `/wait-review` comes first because it always
    // works: while a band above the prompt has buttons up - bet-on-your-agent
    // asking "Did it land?" - ctrl+x tab gives the keys to that band instead.
    const keysHint = isFocused
      ? 'esc hands the keys back to the prompt'
      : showFocusHint
        ? FOCUS_HINT
        : '/wait-review or ctrl+x tab to use these keys · or click them'
    // `o` and `f` while the pane already holds the keys are the other way the
    // first-run line is dismissed. A click while it does not still decides the
    // hunk, and leaves the line up.
    const markRead = async (status: 'ok' | 'flagged') => {
      if (isFocused) await dismissFocusHint($)
      await mark($, current.id, status)
    }
    // The pane's own body, not the terminal: the prompt and status rows sit
    // below it, and sizing pages to the whole screen pushed the controls off
    // the bottom of a long hunk's first page.
    const height = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const chrome =
      CHROME_ROWS +
      (current.note !== undefined ? 1 : 0) +
      (counts.flagged > 0 ? 2 : 0) +
      (noteOffer ? 1 : 0) +
      (truncatedCount > 0 ? 1 : 0) +
      // The controls wrap onto a second row in a narrow pane, and so can the hint.
      (width < 60 ? 1 : 0) +
      (keysHint.length > width ? 1 : 0)
    const room = Math.max(3, height - chrome)
    const reading = await read($, page)
    const offset = reading !== null && reading.id === current.id ? reading.offset : 0
    // The gutter takes the widest line number and its marker; the code wraps in
    // what is left, so a page is however many lines fill the rows there are.
    const gutter = String(current.start + current.added + current.removed + 1).length + 4
    const fit = linesThatFit(current.text, offset, room, Math.max(10, width - gutter))
    const shown = sliceHunk(current.text, offset, fit)
    const isPaged = shown.total > shown.last - shown.first

    return (
      <Box flexDirection="column" gap={1}>
        {head}

        <Box flexDirection="column">
          {/* The counts keep their width and the path gives way, cut from its
              start: shrunk alike, "file 1 of 2" wrapped into a column of its own. */}
          <Box justifyContent="space-between" gap={2}>
            <Text wrap="truncate-start">
              <Text weight="bold">{current.path}</Text>
              <Text dimColor>:{current.start}</Text>
              {current.status === 'later' && <Text color="warning"> · put off</Text>}
            </Text>
            <Box flexShrink={0}>
              <Text tabular>
                {/* Text colors, not `diffAdded`/`diffRemoved`: those are the
                    diff lines' background fills, and as text on the pane they
                    measured #225c2b and #7a2936 live, all but unreadable. */}
                <Text color="success">+{current.added}</Text>{' '}
                <Text color="error">−{current.removed}</Text>
                {where.ofFiles > 1 && (
                  <Text dimColor>
                    {' '}
                    · file {where.atFile} of {where.ofFiles}
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
          {current.note !== undefined && (
            <Text color="warning" wrap="truncate-end">
              your reason: {current.note}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text dimColor>{'─'.repeat(width)}</Text>
          <Code source={shown.text} format="diff" wrap="wrap" />
          {isPaged && (
            <Box justifyContent="space-between" gap={2}>
              <Text dimColor tabular>
                lines {shown.first + 1}–{shown.last} of {shown.total}
              </Text>
              <Box gap={2}>
                {shown.first > 0 && (
                  <Button
                    key="back"
                    hotkey="k"
                    plain
                    dimColor
                    onPress={() => turnPage($, current.id, shown.first - fit)}
                  >
                    back ↑
                  </Button>
                )}
                {shown.last < shown.total && (
                  <Button key="more" hotkey="j" plain onPress={() => turnPage($, current.id, shown.last)}>
                    more ↓
                  </Button>
                )}
              </Box>
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          {/* Dim until the pane holds the keyboard, so a glance says whether a
              letter will land here or in the prompt. */}
          <Box columnGap={2} flexWrap="wrap">
            <Button key="ok" hotkey="o" plain dimColor={!isFocused} onPress={() => markRead('ok')}>
              <Text color={isFocused ? 'success' : undefined}>Looks right</Text>
            </Button>
            <Button key="flag" hotkey="f" plain dimColor={!isFocused} onPress={() => markRead('flagged')}>
              <Text color={isFocused ? 'warning' : undefined}>Flag</Text>
            </Button>
            <Button key="later" hotkey="l" plain dimColor onPress={() => mark($, current.id, 'later')}>
              Later
            </Button>
            <Button key="drop" hotkey="x" plain dimColor onPress={() => dropFile($, current.path)}>
              Skip file
            </Button>
            {undoButton}
          </Box>
          <Text
            weight={showFocusHint ? 'bold' : undefined}
            dimColor={!isFocused && !showFocusHint}
            color={isFocused ? 'suggestion' : undefined}
            wrap="truncate-end"
          >
            {isFocused ? '● ' : null}
            {keysHint}
          </Text>
        </Box>

        {flagCallout}
      </Box>
    )
  })
}
