import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Hunk, HunkStatus, Page } from '../types'
import {
  DEFAULT_IGNORE,
  linesThatFit,
  mergeHunks,
  nextHunk,
  paneHint,
  parseDiff,
  parseIgnore,
  progressOf,
  reviewable,
  reviewNote,
  sliceHunk,
  summaryOf,
  tally,
} from './diff'

const PANE = 'wait-review'

const hunks = atom({ plugin: 'wait-review', key: 'hunks' } as const, [] as Hunk[])
const busy = atom({ plugin: 'wait-review', key: 'busy' } as const, false)
const preexisting = atom({ plugin: 'wait-review', key: 'preexisting' } as const, [] as string[])
const base = atom({ plugin: 'wait-review', key: 'base' } as const, null as string | null)
const lastDecision = atom(
  { plugin: 'wait-review', key: 'lastDecision' } as const,
  null as Decision | null,
)
const noting = atom({ plugin: 'wait-review', key: 'noting' } as const, null as string | null)
const page = atom({ plugin: 'wait-review', key: 'page' } as const, null as Page | null)

/**
 * Rows the review card always spends around the diff: the counts, the path,
 * the location, the rule, the paging row, the controls, the keys hint and the
 * gaps between them. What only sometimes shows is added where it is drawn.
 */
const CHROME_ROWS = 10
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
    // sign the mod is there, and no way in.
    const panes = await $.ui.panes().catch(() => [])
    $.ui.status(`${parts.join(' · ')}${paneHint(panes.find(pane => pane.id === PANE))}`)
  } catch {
    // Nothing to do: the counts are still right, only unshown.
  }
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
const scanRepo = async ($: EngineInterface, config: Config): Promise<Hunk[]> => {
  const root = await repoRoot($)
  if (root === undefined) return []

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
  const untracked = (others?.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, UNTRACKED_LIMIT)
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit(
      $,
      ['diff', '--no-color', '--no-prefix', unified, '--no-index', '--', '/dev/null', path],
      root,
    )
    if (one && one.exitCode <= 1) found.push(...parseDiff(one.stdout))
  }

  return found
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
  if ((await read($, base)) !== null) return
  const found = await runGit($, ['rev-parse', 'HEAD'])
  const sha = found?.exitCode === 0 ? found.stdout.trim() : ''
  if (sha === '') return
  await update($, base, () => sha)

  // What was uncommitted before the agent touched anything is the person's own
  // work in progress, not a review the agent owes them.
  const already = await scanRepo($, config)
  await update($, preexisting, () => already.map(one => one.id).slice(0, SNAPSHOT_LIMIT))
}

/** Re-reads the repository and merges what it finds into the queue. */
const scan = async ($: EngineInterface, config: Config) => {
  const before = await read($, preexisting)
  const found = reviewable(await scanRepo($, config), config.ignore, before)
  await update($, hunks, old => mergeHunks(old, found))
}

const mark = async ($: EngineInterface, id: string, status: HunkStatus) => {
  await update($, noting, () => null)
  const before = (await read($, hunks)).find(one => one.id === id)
  await update($, hunks, old => old.map(one => (one.id === id ? { ...one, status } : one)))
  await update($, lastDecision, () => (before ? { changes: [{ id, from: before.status }] } : null))
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
  await update($, hunks, old => old.map(one => (ids.has(one.id) ? { ...one, status: 'dropped' as const } : one)))
  await update($, lastDecision, () => (changes.length > 0 ? { changes } : null))
  await showStatus($)
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
    await $.command.register({
      name: 'wait-review',
      description: 'Open the wait-review pane and re-read the diff Claude has written so far',
    })
    if (config.autoOpen) void $.ui.open({ id: PANE, title: 'Wait review' }).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'wait-review' }, async $ => {
    await scan($, config)
    await showStatus($)
    const counts = tally(await read($, hunks))
    // Focused only here, not on the autoOpen at session.start: typing `/wait-review`
    // is asking to use it now, where auto-opening at the start of a session is not -
    // stealing the composer's focus before a first prompt would eat its keystrokes.
    const opened = await $.ui
      .open({ id: PANE, title: 'Wait review', focus: true })
      .catch(() => ({ isPlaced: false, reason: 'the engine would not place it' }) as const)
    // Claude Code's own diff panel (2.1.304 on) holds the side of the
    // transcript while it is up, and the pane list still calls this pane
    // shown. What gives it away is the focus just asked for not arriving.
    const ours = (await $.ui.panes().catch(() => [])).find(pane => pane.id === PANE)
    const where = !opened.isPlaced
      ? `Review pane waiting (${opened.reason}).`
      : ours !== undefined && !ours.isFocused
        ? "Review pane open. If you can't see it, Claude Code's diff panel is in front: /diff hides that."
        : 'Review pane open.'

    return {
      text: `${where} ${counts.pending} hunk${counts.pending === 1 ? '' : 's'} to read, ${counts.reviewed} reviewed, ${counts.flagged} flagged.`,
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
    const head = (
      <Box justifyContent="space-between">
        <Text dimColor>{summary === '' ? 'nothing to read' : summary}</Text>
        {isBusy && <Text color="claude">Claude is working</Text>}
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
        {hasNote ? 'Edit note' : 'Say why'}
      </Button>
    )

    // The note box is a mode and does not depend on a card being up, so it is
    // answered before anything else.
    if (noteFor !== null && hasInput && 'Input' in table) {
      const { Input } = table
      const target = list.find(one => one.id === noteFor)

      return (
        <Box flexDirection="column" gap={1}>
          {head}
          <Box flexDirection="column">
            <Text wrap="truncate-start" weight="bold">
              {target?.path ?? 'that hunk'}
            </Text>
            <Input
              key="note-text"
              label="Why is this wrong?"
              placeholder="Enter on an empty box if the diff says it"
              submitLabel="Attach"
              autoFocus
              onSubmit={value => saveNote($, noteFor, value)}
            />
          </Box>
        </Box>
      )
    }

    if (!current) {
      const isFresh = counts.reviewed === 0 && counts.dropped === 0 && counts.flagged === 0

      return (
        <Box flexDirection="column" gap={1}>
          {head}
          {isFresh ? (
            <Box flexDirection="column">
              <Text>Nothing to read yet.</Text>
              <Text dimColor>
                As Claude changes files, each change lands here to read while it works.
              </Text>
              <Text dimColor>o looks right · f flag it for Claude · l later · x skip the file</Text>
            </Box>
          ) : (
            <Text dimColor>Diff read. Nothing waiting on you.</Text>
          )}
          {noteOffer && <Box>{noteOffer}</Box>}
          {undoButton && <Box>{undoButton}</Box>}
        </Box>
      )
    }

    const where = progressOf(list, current)
    // The pane's own body, not the terminal: the prompt and status rows sit
    // below it, and sizing pages to the whole screen pushed the controls off
    // the bottom of a long hunk's first page.
    // Hotkeys only land while the pane holds the keyboard; say how to give it
    // the keys, since pressing `o` without that types an o into the prompt.
    // /wait-review comes first because it always works: while a band above the
    // prompt has buttons up - bet-on-your-agent asking "Did it land?" - ctrl+x
    // tab gives the keys to that band instead of this pane.
    const keysHint = e.props.isFocused
      ? 'esc hands the keys back to the prompt'
      : '/wait-review or ctrl+x tab to use these keys · or click them'
    const height = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const chrome =
      CHROME_ROWS +
      (current.note !== undefined ? 1 : 0) +
      (noteOffer ? 1 : 0) +
      (counts.flagged > 0 ? 1 : 0) +
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
          <Box justifyContent="space-between" gap={2}>
            <Text wrap="truncate-start" weight="bold">
              {current.path}
            </Text>
            {where.ofFiles > 1 && (
              <Text dimColor tabular>
                file {where.atFile} of {where.ofFiles}
              </Text>
            )}
          </Box>
          <Box justifyContent="space-between" gap={2}>
            <Text dimColor tabular>
              line {current.start} · <Text color="diffAdded">+{current.added}</Text>{' '}
              <Text color="diffRemoved">−{current.removed}</Text>
              {current.status === 'later' ? ' · put off' : ''}
            </Text>
            <Text dimColor tabular>
              {where.hereLeft > 1 ? `${where.hereLeft} left here · ` : ''}
              {where.totalLeft} left
            </Text>
          </Box>
          {current.note !== undefined && (
            <Text color="warning" wrap="truncate-end">
              note: {current.note}
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
          <Box gap={2} flexWrap="wrap">
            <Button key="ok" hotkey="o" plain onPress={() => mark($, current.id, 'ok')}>
              Looks right
            </Button>
            <Button key="flag" hotkey="f" plain onPress={() => mark($, current.id, 'flagged')}>
              Flag
            </Button>
            <Button key="later" hotkey="l" plain dimColor onPress={() => mark($, current.id, 'later')}>
              Later
            </Button>
            <Button key="drop" hotkey="x" plain dimColor onPress={() => dropFile($, current.path)}>
              Skip file
            </Button>
            {undoButton}
          </Box>
          {noteOffer && <Box>{noteOffer}</Box>}
          {counts.flagged > 0 && (
            <Text color="warning">
              {counts.flagged} flagged → sent to Claude with your next message
            </Text>
          )}
          <Text dimColor>{keysHint}</Text>
        </Box>
      </Box>
    )
  })
}
