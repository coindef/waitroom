import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Baseline, DiffCard, TreeScan } from '../types'
import {
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  enabledRowKey,
  overflowLine,
  parseDiffFiles,
  SUBTITLE,
  summaryFor,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  yieldsBand,
} from './changed'

/** `$.store` key for a disable the settings write could not persist. */
const DISABLED_KEY = 'disabled'
/** Untracked files diffed one by one per scan, so a stray folder cannot stall it. */
const UNTRACKED_LIMIT = 100

const baseline = atom({ plugin: 'wait-changed', key: 'baseline' } as const, null as Baseline | null)
const card = atom({ plugin: 'wait-changed', key: 'card' } as const, null as DiffCard | null)

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string) =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

/**
 * Every file changed against HEAD right now: staged and unstaged tracked
 * changes, plus untracked files, which plain `git diff` says nothing about.
 * Read-only: diff and ls-files, nothing else.
 */
const scanTree = async ($: EngineInterface): Promise<TreeScan> => {
  const root = await repoRoot($)
  if (root === undefined) return { ok: false }

  const tracked = await runGit($, ['diff', 'HEAD', '--no-color', '--no-prefix'], root)
  const others = await runGit($, ['ls-files', '--others', '--exclude-standard'], root)
  // A repository with no commit yet has no HEAD. Untracked files are still a
  // diff. Both commands failing is not an empty tree — there is nothing to
  // summarize, and the card stays silent rather than guessing.
  const trackedOk = tracked !== undefined && tracked.exitCode === 0
  const othersOk = others !== undefined && others.exitCode === 0
  if (!trackedOk && !othersOk) return { ok: false }

  const chunks: string[] = trackedOk ? [tracked.stdout] : []
  const untracked = othersOk
    ? others.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(path => path !== '')
        .slice(0, UNTRACKED_LIMIT)
    : []
  for (const path of untracked) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit($, ['diff', '--no-color', '--no-prefix', '--no-index', '--', '/dev/null', path], root)
    if (one && one.exitCode <= 1) chunks.push(one.stdout)
  }

  return { ok: true, files: parseDiffFiles(chunks.join('\n')) }
}

const setEnabled = async ($: EngineInterface, want: boolean): Promise<{ deny?: string }> => {
  const rows = await $.config.list().catch(() => [])

  return $.config
    .set({ key: enabledRowKey(rows), value: want })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
}

/**
 * Whether the card is allowed to appear. `enabled` is the settings field;
 * `locallyOff` is the copy `$.store` keeps when that write was refused.
 * Both reset when the module loads, which is also what a hot reload does.
 */
let enabled = true
let locallyOff = false
let prefLoaded = false
let prefLoading: Promise<void> | null = null
/** The turn whose card 关闭 already put away, so a second complete cannot bring it back. */
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

/**
 * Permanent off. The settings field is the switch `/plugin` shows; when
 * that write is refused, a local preference keeps the card silent anyway,
 * and `/wait-changed` is what turns that preference back off.
 */
const silenceForever = async ($: EngineInterface): Promise<string | undefined> => {
  await update($, card, () => null)
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

const enableCard = async ($: EngineInterface): Promise<string | undefined> => {
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
      name: 'wait-changed',
      description: 'Turn the turn-end diff card on or off',
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * One command, on or off: `/wait-changed` flips the same `enabled` setting
   * the install screen and `/plugin` show. Turning off also sticks when that
   * write is refused, because 不再显示 promised the card would stay gone.
   * Turning on clears that local preference, which is the way back when the
   * settings screen never moved.
   */
  on('command.run', { command: 'wait-changed' }, async $ => {
    await ensurePref($)
    if (silenced()) {
      const reason = await enableCard($)

      return { text: reason === undefined ? turnedOnLine() : toggleRefusedLine(reason) }
    }
    const reason = await silenceForever($)

    return { text: reason === undefined ? turnedOffLine() : turnedOffLocallyLine(reason) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // The previous card belongs to the previous turn. Gone before this turn
    // paints, so a wait never opens on last turn's list.
    dismissedFor = null
    await update($, card, () => null)
    await ensurePref($)
    if (silenced()) {
      await update($, baseline, () => null)

      return next(e)
    }
    const scan = await scanTree($)
    await update($, baseline, () => ({ turnId: e.turnId, scan }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    await ensurePref($)
    if (silenced() || dismissedFor === e.turnId) {
      await update($, card, () => null)

      return done
    }
    const after = await scanTree($)
    const started = await read($, baseline)
    const before = started !== null && started.turnId === e.turnId ? started.scan : null
    const summary = summaryFor(before, after)
    await update($, card, () =>
      summary === null ? null : { turnId: e.turnId, rows: summary.rows, overflow: summary.overflow },
    )

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The card rides the row above the prompt — under the transcript, not over
   * it, and not a modal. It is drawn only once the turn has finished
   * (`isWorking` is false) and only when this turn changed files.
   *
   * The row shows one mod at a time. A breathe nudge, which is the only thing
   * ahead of this card, keeps the row; a ship offer and the bet's question
   * wait until 关闭 or 不再显示 clears it. Neither of those is up while a
   * turn runs, and neither is this card.
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
    }
    const mine = (
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={2}>
          <Text weight="bold" wrap="truncate-end">
            {TITLE}
          </Text>
          {/* On the title row, so a short band still offers both actions
              after the file list has taken the rows beneath them. */}
          <Box flexShrink={0} columnGap={2}>
            <Button key="dismiss" plain onPress={() => dismiss()}>
              {DISMISS_LABEL}
            </Button>
            <Button key="disable" plain dimColor onPress={() => silenceForever($)}>
              {DISABLE_LABEL}
            </Button>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {SUBTITLE}
        </Text>
        {showing.rows.map(row => (
          <Box key={row.path} justifyContent="space-between" gap={2}>
            <Text wrap="truncate-start">{row.path}</Text>
            <Box flexShrink={0}>
              <Text tabular>{row.hint}</Text>
            </Box>
          </Box>
        ))}
        {showing.overflow > 0 && <Text dimColor>{overflowLine(showing.overflow)}</Text>}
      </Box>
    )
    const beneath = await next(e).catch(() => undefined)

    return beneath !== undefined && yieldsBand('wait-changed', drawnBy(beneath)) ? beneath : mine
  }).catch(($, e, next) => next(e))
}
