import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Hunk, HunkStatus, Touch } from '../types'
import { mergeHunks, nextHunk, parseDiff, reviewNote, tally, toRepoPath, trimHunk } from './diff'

const PANE = 'wait-review'

const hunks = atom({ plugin: 'wait-review', key: 'hunks' } as const, [] as Hunk[])
const touches = atom({ plugin: 'wait-review', key: 'touches' } as const, [] as Touch[])
const turn = atom({ plugin: 'wait-review', key: 'turn' } as const, 0)
const busy = atom({ plugin: 'wait-review', key: 'busy' } as const, false)

/** Rows the pane spends on its own counts, path, buttons and footer. */
const CHROME_ROWS = 9
/** Paths per `git diff`, so a long queue cannot overrun the argument list. */
const PATHS_PER_CALL = 60

type Config = {
  settleTurns: number
  contextLines: number
  autoOpen: boolean
  attachFlags: boolean
}

const whole = (value: unknown, fallback: number): number => {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

const showStatus = async ($: EngineInterface) => {
  const counts = tally(await read($, hunks))
  const parts: string[] = []
  if (counts.pending > 0) parts.push(`${counts.pending} to read`)
  if (counts.flagged > 0) parts.push(`${counts.flagged} flagged`)
  $.ui.status(parts.length > 0 ? `review: ${parts.join(' · ')}` : undefined)
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

    // Working tree against the last commit: the agent's work is usually
    // uncommitted, so HEAD is the base the person last saw.
    let diff = await runGit($, ['diff', 'HEAD', '--no-color', '--no-prefix', unified, '--', ...batch], root)
    // A repository with no commits yet has no HEAD to diff against.
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

const noteTouch = async ($: EngineInterface, path: string | undefined) => {
  if (path === undefined || path === '') return
  const now = await read($, turn)
  await update($, touches, old =>
    [...old.filter(one => one.path !== path), { path, turn: now }].slice(-300),
  )
}

const mark = async ($: EngineInterface, id: string, status: HunkStatus) => {
  await update($, hunks, old => old.map(one => (one.id === id ? { ...one, status } : one)))
  await showStatus($)
}

export const register: Register = (on, options) => {
  const config: Config = {
    settleTurns: whole(options.settleTurns, 0),
    contextLines: whole(options.contextLines, 3),
    autoOpen: options.autoOpen !== false,
    attachFlags: options.attachFlags !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wait-review',
      description: 'Open the wait-review pane and re-read the diff Claude has written so far',
    })
    if (config.autoOpen) void $.ui.open({ id: PANE, title: 'Wait review' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'wait-review' }, async $ => {
    await scan($, config)
    await showStatus($)
    const counts = tally(await read($, hunks))
    const opened = await $.ui.open({ id: PANE, title: 'Wait review' })
    const where = opened.isPlaced ? 'Review pane open.' : `Review pane waiting (${opened.reason}).`

    return {
      text: `${where} ${counts.pending} hunk${counts.pending === 1 ? '' : 's'} to read, ${counts.reviewed} reviewed, ${counts.flagged} flagged.`,
    }
  })

  // One hook per tool so `e` narrows to that tool's own input.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteTouch($, e.file_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteTouch($, e.file_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteTouch($, e.notebook_path)

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
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, hunks)
    const isBusy = await read($, busy)
    const counts = tally(list)
    const current = nextHunk(list)

    const head = (
      <Text dimColor>
        {counts.pending} to read · {counts.reviewed} reviewed · {counts.flagged} flagged
        {isBusy ? ' · Claude is working' : ''}
      </Text>
    )

    if (!current) {
      return (
        <Box flexDirection="column" gap={1}>
          {head}
          <Text dimColor>
            {counts.reviewed === 0
              ? 'Nothing written yet. Hunks show up here as Claude edits files.'
              : 'Diff read. Nothing waiting on you.'}
          </Text>
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
        </Box>
        {counts.flagged > 0 && (
          <Text dimColor>
            {counts.flagged} flagged hunk{counts.flagged === 1 ? '' : 's'} go to Claude with your next message
          </Text>
        )}
      </Box>
    )
  })
}
