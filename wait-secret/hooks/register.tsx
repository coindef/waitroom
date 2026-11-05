import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Baseline, SecretCard, TreeScan } from '../types'
import {
  splitNul,
  baselineOf,
  cardFor,
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  enabledRowKey,
  overflowLine,
  parseAddedLines,
  rowLine,
  statusLine,
  SUBTITLE,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  yieldsBand,
} from './secret'

/** `$.store` key for a disable the settings write could not persist. */
const DISABLED_KEY = 'disabled'
/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
const UNTRACKED_LIMIT = 100

const baseline = atom({ plugin: 'wait-secret', key: 'baseline' } as const, null as Baseline | null)
const card = atom({ plugin: 'wait-secret', key: 'card' } as const, null as SecretCard | null)

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * The lines every changed file adds against HEAD right now: the same
 * read-only scan of this turn's changes (staged and unstaged tracked changes,
 * plus untracked files). diff and ls-files, nothing else, and no file read.
 */
const scanTree = async ($: EngineInterface): Promise<TreeScan> => {
  const root = await repoRoot($)
  if (root === undefined) return { ok: false }

  // core.quotePath=false keeps non-ASCII names raw in the diff headers, so
  // the path on a row is the path on disk rather than octal escapes.
  const tracked = await runGit($, ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--no-color', '--no-prefix', '--no-ext-diff'], root)
  // -z: NUL-separated and never quoted, so a name with a space, a quote or
  // non-ASCII characters comes back as it is on disk instead of skipped.
  const others = await runGit($, ['ls-files', '-z', '--others', '--exclude-standard'], root)
  const trackedOk = tracked !== undefined && tracked.exitCode === 0
  const othersOk = others !== undefined && others.exitCode === 0
  if (!trackedOk && !othersOk) return { ok: false }

  const chunks: string[] = trackedOk ? [tracked.stdout] : []
  const untracked = othersOk
    ? splitNul(others.stdout).slice(0, UNTRACKED_LIMIT)
    : []
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit($, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-prefix', '--no-index', '--', '/dev/null', path], root)
    if (one && one.exitCode <= 1) chunks.push(one.stdout)
  }

  return { ok: true, files: parseAddedLines(chunks.join('\n')) }
}

const setEnabled = async ($: EngineInterface, want: boolean): Promise<{ deny?: string }> => {
  const rows = await $.config.list().catch(() => [])

  return $.config
    .set({ key: enabledRowKey(rows), value: want })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
}

/**
 * Whether the list is allowed to appear. `enabled` is the settings field;
 * `locallyOff` is the copy `$.store` keeps when that write was refused.
 * Both reset when the module loads, which is also what a hot reload does.
 */
let enabled = true
let locallyOff = false
let prefLoaded = false
let prefLoading: Promise<void> | null = null
/** The turn whose list Close already put away, so a second complete cannot bring it back. */
let dismissedFor: string | null = null

const silenced = (): boolean => !enabled || locallyOff

const ensurePref = ($: EngineInterface): Promise<void> => {
  if (prefLoaded) return Promise.resolve()
  if (prefLoading === null) {
    prefLoading = $.store
      .get(DISABLED_KEY)
      .catch(() => undefined)
      .then(value => {
        locallyOff = value === true
        prefLoaded = true
      })
  }

  return prefLoading
}

/** The status line, from the list that is up. It never throws outward. */
const showStatus = async ($: EngineInterface) => {
  try {
    const now = silenced() ? null : await read($, card)
    $.ui.status(now === null ? undefined : statusLine(now.hits.length + now.overflow))
  } catch {
    // Nothing to do: the list is still right, only unshown.
  }
}

const silenceForever = async ($: EngineInterface): Promise<string | undefined> => {
  await update($, card, () => null)
  $.ui.status(undefined)
  const done = await setEnabled($, false)
  if (done.deny !== undefined) {
    locallyOff = true
    await $.store.set(DISABLED_KEY, true).catch(() => undefined)

    return done.deny
  }
  enabled = false
  locallyOff = false
  await $.store.set(DISABLED_KEY, false).catch(() => undefined)

  return undefined
}

const enableList = async ($: EngineInterface): Promise<string | undefined> => {
  const done = await setEnabled($, true)
  if (done.deny !== undefined) return done.deny
  enabled = true
  locallyOff = false
  await $.store.set(DISABLED_KEY, false).catch(() => undefined)

  return undefined
}

export const register: Register = (on, options) => {
  // A fresh load starts from this install's settings and reads the store
  // again. Resetting here covers a second register in the same process.
  enabled = options.enabled !== false
  locallyOff = false
  prefLoaded = false
  prefLoading = null
  dismissedFor = null

  on('session.start', async ($, e, next) => {
    await ensurePref($)
    await $.command.register({
      name: 'wait-secret',
      description: 'Turn the likely-secret warning on or off',
    })
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'wait-secret' }, async $ => {
    await ensurePref($)
    if (silenced()) {
      const reason = await enableList($)

      return { text: reason === undefined ? turnedOnLine() : toggleRefusedLine(reason) }
    }
    const reason = await silenceForever($)

    return { text: reason === undefined ? turnedOffLine() : turnedOffLocallyLine(reason) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // The previous list belongs to the previous turn. Gone before this turn
    // paints, so a wait never opens on last turn's count.
    dismissedFor = null
    $.ui.status(undefined)
    await update($, card, () => null)
    await ensurePref($)
    if (silenced()) {
      await update($, baseline, () => null)

      return next(e)
    }
    const scan = await scanTree($)
    await update($, baseline, () => baselineOf(e.turnId, scan))

    return next(e)
  }).catch(($, e, next) => next(e))

  /** Stop: the turn's answer goes back first and untouched; then the tree is read once more. */
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      if (e.agentId !== undefined) return done
      await ensurePref($)
      if (silenced() || dismissedFor === e.turnId) {
        await update($, card, () => null)

        return done
      }
      const started = await read($, baseline)
      const before = started !== null && started.turnId === e.turnId ? started : null
      const found = before === null ? null : cardFor(before, await scanTree($))
      await update($, card, () => (found === null ? null : { turnId: e.turnId, ...found }))
      await showStatus($)
    } catch {
      // Bookkeeping only: the turn's answer goes back as it was.
    }

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The list rides the row above the prompt, once the turn has finished, and
   * only when the turn wrote a line that looks like a secret. It comes last
   * in the row; the status line carries the count while another mod has it.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await ensurePref($)
    if (silenced() || e.props.hasSurvey || e.props.isWorking) return next(e)
    const showing = await read($, card)
    if (!showing) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const dismiss = async () => {
      dismissedFor = showing.turnId
      await update($, card, () => null)
      await showStatus($)
    }
    const mine = (
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={2}>
          <Text weight="bold" wrap="truncate-end">
            {TITLE}
          </Text>
          <Box flexShrink={0} columnGap={2}>
            <Button key="dismiss" plain onPress={() => dismiss()}>
              {DISMISS_LABEL}
            </Button>
            <Button key="disable" plain dimColor onPress={() => void silenceForever($).catch(() => undefined)}>
              {DISABLE_LABEL}
            </Button>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {SUBTITLE}
        </Text>
        {showing.hits.map(hit => (
          <Text key={`${hit.path}:${hit.line}`} wrap="truncate-start">
            {rowLine(hit)}
          </Text>
        ))}
        {showing.overflow > 0 && <Text dimColor>{overflowLine(showing.overflow)}</Text>}
      </Box>
    )
    const beneath = await next(e).catch(() => undefined)

    return beneath !== undefined && yieldsBand('wait-secret', drawnBy(beneath)) ? beneath : mine
  }).catch(($, e, next) => next(e))
}
