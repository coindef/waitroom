import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Decision, Hunk, HunkStatus, Touch } from '../types'
import {
  DEFAULT_IGNORE,
  isIgnored,
  mergeHunks,
  nextHunk,
  parseDiff,
  parseIgnore,
  reviewNote,
  tally,
  toRepoPath,
  trimHunk,
} from './diff'

const PANE = 'wait-review'

const hunks = atom({ plugin: 'wait-review', key: 'hunks' } as const, [] as Hunk[])
const touches = atom({ plugin: 'wait-review', key: 'touches' } as const, [] as Touch[])
const turn = atom({ plugin: 'wait-review', key: 'turn' } as const, 0)
const busy = atom({ plugin: 'wait-review', key: 'busy' } as const, false)
const base = atom({ plugin: 'wait-review', key: 'base' } as const, null as string | null)
const lastDecision = atom(
  { plugin: 'wait-review', key: 'lastDecision' } as const,
  null as Decision | null,
)
const noting = atom({ plugin: 'wait-review', key: 'noting' } as const, null as string | null)

/** Rows the pane spends on its own counts, path, buttons and footer. */
const CHROME_ROWS = 9
/** Paths per `git diff`, so a long queue cannot overrun the argument list. */
const PATHS_PER_CALL = 60

type Config = {
  settleTurns: number
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
    if (counts.flagged > 0) parts.push(`${counts.flagged} flagged`)
    if (parts.length === 0) {
      $.ui.status(undefined)

      return
    }
    // Below 144 columns a pane nobody asked for is never placed, so without
    // this the count is the only sign the mod is there, and no way in.
    const panes = await $.ui.panes().catch(() => [])
    const isShown = panes.some(pane => pane.id === PANE && pane.isPlaced)
    $.ui.status(`review: ${parts.join(' · ')}${isShown ? '' : ' · /wait-review'}`)
  } catch {
    // Nothing to do: the counts are still right, only unshown.
  }
}

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/**
 * Anchors the review to the commit the session started on.
 *
 * Called once, at session start: a commit made later must not take its own
 * changes out of the queue, because a commit is not a review.
 */
const anchorBase = async ($: EngineInterface) => {
  const found = await runGit($, ['rev-parse', 'HEAD'])
  const sha = found?.exitCode === 0 ? found.stdout.trim() : ''
  await update($, base, () => (sha === '' ? null : sha))
}

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * Re-reads the diff of every settled path and merges it into the queue.
 *
 * Every settled path is rescanned, not only the newly settled ones, so a hunk
 * the agent has since rewritten comes back for review under its new id and one
 * it reverted leaves the queue.
 */
const scan = async ($: EngineInterface, config: Config) => {
  const root = await repoRoot($)
  if (root === undefined) return

  const now = await read($, turn)
  const anchor = await read($, base)
  const touched = await read($, touches)
  // git prints paths relative to the root and the tools carry absolute ones,
  // so everything below this line speaks git's spelling.
  const ready = [
    ...new Set(
      touched
        .filter(one => now - one.turn >= config.settleTurns)
        .map(one => toRepoPath(root, one.path))
        .filter(path => !path.startsWith('/') && !path.startsWith('../')),
    ),
  ]
  if (ready.length === 0) return

  const found: Hunk[] = []
  const unified = `--unified=${config.contextLines}`

  for (let at = 0; at < ready.length; at += PATHS_PER_CALL) {
    const batch = ready.slice(at, at + PATHS_PER_CALL)

    // Against the session's own starting commit, so work the agent committed
    // mid-session is still waiting to be read.
    let diff = anchor === null
      ? undefined
      : await runGit($, ['diff', anchor, '--no-color', '--no-prefix', unified, '--', ...batch], root)
    // The anchor can stop resolving under a rebase or a reset; HEAD still does.
    if (!diff || diff.exitCode !== 0) {
      diff = await runGit($, ['diff', 'HEAD', '--no-color', '--no-prefix', unified, '--', ...batch], root)
    }
    // A repository with no commits yet has neither.
    if (!diff || diff.exitCode !== 0) {
      diff = await runGit($, ['diff', '--no-color', '--no-prefix', unified, '--', ...batch], root)
    }
    if (diff?.exitCode === 0) found.push(...parseDiff(diff.stdout))

    // A file the agent created is untracked: no blob on either side, so plain
    // `git diff` says nothing about it at all.
    const others = await runGit($, ['ls-files', '--others', '--exclude-standard', '--', ...batch], root)
    const untracked = (others?.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    for (const path of untracked) {
      // --no-index exits 1 when the two sides differ, which is the point here.
      const one = await runGit($, [
        'diff', '--no-color', '--no-prefix', unified, '--no-index', '--', '/dev/null', path,
      ], root)
      if (one && one.exitCode <= 1) found.push(...parseDiff(one.stdout))
    }
  }

  await update($, hunks, old => mergeHunks(old, found, ready))
}

const noteTouch = async ($: EngineInterface, path: string | undefined, ignore: readonly string[]) => {
  if (path === undefined || path === '') return
  if (isIgnored(path, ignore)) return
  const now = await read($, turn)
  await update($, touches, old =>
    [...old.filter(one => one.path !== path), { path, turn: now }].slice(-300),
  )
}

const mark = async ($: EngineInterface, id: string, status: HunkStatus) => {
  await update($, noting, () => null)
  const before = (await read($, hunks)).find(one => one.id === id)
  await update($, hunks, old => old.map(one => (one.id === id ? { ...one, status } : one)))
  await update($, lastDecision, () => (before ? { id, from: before.status } : null))
  await showStatus($)
}

/** Opens the note box for a hunk, or closes it when given nothing. */
const setNoting = async ($: EngineInterface, id: string | null) => {
  await update($, noting, () => id)
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

/** Puts the last call back, so misreading a hunk costs one press, not a rescan. */
const undo = async ($: EngineInterface) => {
  const last = await read($, lastDecision)
  if (!last) return
  await update($, hunks, old =>
    old.map(one => (one.id === last.id ? { ...one, status: last.from } : one)),
  )
  await update($, lastDecision, () => null)
  await showStatus($)
}

/**
 * Waves away everything still unread in one file.
 *
 * Dropped, not approved: a regenerated file is noise to clear, and the counts
 * should not pretend it was read.
 */
const dropFile = async ($: EngineInterface, path: string) => {
  await update($, hunks, old =>
    old.map(one =>
      one.path === path && (one.status === 'pending' || one.status === 'later')
        ? { ...one, status: 'dropped' }
        : one,
    ),
  )
  await update($, lastDecision, () => null)
  await showStatus($)
}

export const register: Register = (on, options) => {
  const config: Config = {
    settleTurns: whole(options.settleTurns, 0),
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
    // Anchored before anything else here: the review is wrong without it, and
    // registering a command or opening a pane is not worth losing it to.
    await anchorBase($)
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
    const opened = await $.ui
      .open({ id: PANE, title: 'Wait review' })
      .catch(() => ({ isPlaced: false, reason: 'the engine would not place it' }) as const)
    const where = opened.isPlaced ? 'Review pane open.' : `Review pane waiting (${opened.reason}).`

    return {
      text: `${where} ${counts.pending} hunk${counts.pending === 1 ? '' : 's'} to read, ${counts.reviewed} reviewed, ${counts.flagged} flagged.`,
    }
  })

  // One hook per tool so `e` narrows to that tool's own input.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteTouch($, e.file_path, config.ignore)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteTouch($, e.file_path, config.ignore)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteTouch($, e.notebook_path, config.ignore)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, turn, now => now + 1)
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
      old.map(one => (ids.has(one.id) ? { ...one, status: 'sent' } : one)),
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
    const flagged = last && list.find(one => one.id === last.id)?.status === 'flagged' ? last.id : null

    const head = (
      <Text dimColor>
        {counts.pending} to read · {counts.reviewed} reviewed · {counts.flagged} flagged
        {counts.dropped > 0 ? ` · ${counts.dropped} dropped` : ''}
        {isBusy ? ' · Claude is working' : ''}
      </Text>
    )

    const undoButton = last && (
      <Button key="undo" hotkey="u" dimColor onPress={() => undo($)}>
        Undo
      </Button>
    )

    // Offered wherever a flagged hunk is waiting on a reason, which includes an
    // emptied queue: flagging the last hunk is the commonest way to reach here,
    // and that is exactly when the reason still needs saying.
    const hasNote = flagged !== null && list.find(one => one.id === flagged)?.note !== undefined
    const noteOffer = flagged !== null && hasInput && (
      <Box>
        <Button key="note-open" hotkey="n" dimColor onPress={() => setNoting($, flagged)}>
          {hasNote ? 'Edit note' : 'Say why'}
        </Button>
      </Box>
    )

    // The note box is a mode and does not depend on a card being up, so it is
    // answered before anything else.
    if (noteFor !== null && hasInput && 'Input' in table) {
      const { Input } = table
      const target = list.find(one => one.id === noteFor)

      return (
        <Box flexDirection="column" gap={1}>
          {head}
          <Text dimColor>{target?.path ?? 'that hunk'}</Text>
          <Input
            key="note-text"
            label="Why is this wrong?"
            placeholder="Enter on an empty box if the diff says it"
            submitLabel="Attach"
            autoFocus
            onSubmit={value => saveNote($, noteFor, value)}
          />
        </Box>
      )
    }

    if (!current) {
      return (
        <Box flexDirection="column" gap={1}>
          {head}
          <Text dimColor>
            {counts.reviewed === 0 && counts.dropped === 0 && counts.flagged === 0
              ? 'Nothing written yet. Hunks show up here as Claude edits files.'
              : 'Diff read. Nothing waiting on you.'}
          </Text>
          {noteOffer}
          {undoButton && <Box>{undoButton}</Box>}
        </Box>
      )
    }

    const room = Math.max(3, (e.viewport?.rows ?? 24) - CHROME_ROWS)
    const shown = trimHunk(current.text, room)

    return (
      <Box flexDirection="column" gap={1}>
        {head}
        <Box flexDirection="column">
          <Text bold>{current.path}</Text>
          <Text dimColor>
            {current.header} · +{current.added} −{current.removed}
            {current.status === 'later' ? ' · put off' : ''}
          </Text>
          {current.note !== undefined && <Text>note: {current.note}</Text>}
        </Box>
        <Code source={shown.text} format="diff" wrap="truncate-end" />
        {shown.hidden > 0 && <Text dimColor>… {shown.hidden} more lines in this hunk</Text>}
        <Box gap={1}>
          <Button key="ok" hotkey="o" variant="primary" onPress={() => mark($, current.id, 'ok')}>
            Looks right
          </Button>
          <Button key="flag" hotkey="f" onPress={() => mark($, current.id, 'flagged')}>
            Flag
          </Button>
          <Button key="later" hotkey="l" dimColor onPress={() => mark($, current.id, 'later')}>
            Later
          </Button>
          <Button key="drop" hotkey="x" dimColor onPress={() => dropFile($, current.path)}>
            Skip file
          </Button>
          {undoButton}
        </Box>
        {noteOffer}
        {counts.flagged > 0 && (
          <Text dimColor>
            {counts.flagged} flagged hunk{counts.flagged === 1 ? '' : 's'} go to Claude with your next message
          </Text>
        )}
      </Box>
    )
  })
}
