import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Baseline, FileAdds, SecretCard } from '../types'
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
  DIFF_TOO_BIG,
  partialFilesLine,
  withTurnOff,
  RANGE_UNREAD,
  SCAN_UNREAD,
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

/**
 * Untracked files diffed one by one per scan. `turn.start` waits for this
 * before the turn begins, so a stray folder cannot be opened in full.
 */
const UNTRACKED_LIMIT = 100

const baseline = atom({ plugin: 'wait-secret', key: 'baseline' } as const, null as Baseline | null)
const card = atom({ plugin: 'wait-secret', key: 'card' } as const, null as SecretCard | null)

type GitRun = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }

const runGit = async ($: EngineInterface, argv: readonly string[], cwd?: string): Promise<GitRun | undefined> =>
  $.process.run(['git', ...argv], { cwd, timeoutMs: 15000 }).catch(() => undefined)

/** The repository root, or undefined where the session is not in a repository. */
const repoRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--show-toplevel'])
  const root = found?.exitCode === 0 ? found.stdout.trim() : ''

  return root === '' ? undefined : root
}

type Head = { kind: 'commit'; rev: string } | { kind: 'unborn' } | { kind: 'unread'; gap: string }

type Read = {
  ok: boolean
  files: FileAdds[]
  /** HEAD, or the empty tree when the repository has no commit yet. */
  startRev?: string
  unborn?: boolean
  /** Set when this read is not a finished tree. Never paired with `ok`. */
  gap?: string
}

const diffArgs = (revision: readonly string[]) =>
  ['-c', 'core.quotePath=false', 'diff', ...revision, '--no-color', '--no-prefix', '--no-ext-diff'] as const

/** A diff the host cut off is not usable, whatever follows the cut. Exit 1 is a real `--no-index` difference. */
const takeDiff = (run: GitRun | undefined, allowOne = false): { ok: true; stdout: string } | { ok: false; gap: string } => {
  if (run?.isStdoutTruncated) return { ok: false, gap: DIFF_TOO_BIG }
  if (run !== undefined && (run.exitCode === 0 || (allowOne && run.exitCode === 1))) return { ok: true, stdout: run.stdout }

  return { ok: false, gap: SCAN_UNREAD }
}

/**
 * HEAD's commit, or unborn when this is a branch with no commit yet.
 * A missing object that is not that case is unread: an empty diff is the
 * wrong answer for it.
 */
const readHead = async ($: EngineInterface, root: string): Promise<Head> => {
  const verified = await runGit($, ['rev-parse', '--verify', '--quiet', 'HEAD'], root)
  if (verified === undefined || verified.isStdoutTruncated) {
    return { kind: 'unread', gap: verified?.isStdoutTruncated ? DIFF_TOO_BIG : SCAN_UNREAD }
  }
  const rev = verified.exitCode === 0 ? verified.stdout.trim() : ''
  if (rev !== '') return { kind: 'commit', rev }
  const branch = await runGit($, ['symbolic-ref', '-q', 'HEAD'], root)
  if (branch?.isStdoutTruncated) return { kind: 'unread', gap: DIFF_TOO_BIG }
  if (branch !== undefined && branch.exitCode === 0 && branch.stdout.trim() !== '') return { kind: 'unborn' }

  return { kind: 'unread', gap: SCAN_UNREAD }
}

/**
 * Tracked changes. `git diff HEAD` exits 128 when nothing has been committed,
 * which is not an empty tree: staged lines are `git diff --cached` against
 * the empty tree, plus unstaged lines against the index. Any other failed
 * diff stays failed.
 */
const trackedText = async (
  $: EngineInterface,
  root: string,
  head: Head,
): Promise<{ ok: true; text: string; startRev: string; unborn: boolean } | { ok: false; gap: string; startRev?: string; unborn?: boolean }> => {
  if (head.kind === 'unread') return { ok: false, gap: head.gap }
  if (head.kind === 'commit') {
    const diff = takeDiff(await runGit($, diffArgs(['HEAD']), root))
    if (!diff.ok) return { ok: false, gap: diff.gap, startRev: head.rev, unborn: false }

    return { ok: true, text: diff.stdout, startRev: head.rev, unborn: false }
  }
  const empty = await runGit($, ['hash-object', '-t', 'tree', '/dev/null'], root)
  if (empty?.isStdoutTruncated) return { ok: false, gap: DIFF_TOO_BIG, unborn: true }
  const tree = empty !== undefined && empty.exitCode === 0 ? empty.stdout.trim() : ''
  if (tree === '') return { ok: false, gap: SCAN_UNREAD, unborn: true }
  const staged = takeDiff(await runGit($, diffArgs(['--cached', tree]), root))
  if (!staged.ok) return { ok: false, gap: staged.gap, startRev: tree, unborn: true }
  const unstaged = takeDiff(await runGit($, diffArgs([]), root))
  if (!unstaged.ok) return { ok: false, gap: unstaged.gap, startRev: tree, unborn: true }

  return { ok: true, text: `${staged.stdout}\n${unstaged.stdout}`, startRev: tree, unborn: true }
}

/**
 * Untracked names, in the order git lists them, up to `UNTRACKED_LIMIT`.
 * Each name is its own `git diff --no-index`, and the turn waits on the
 * scan, so the rest of a long list is not opened. Past the cap, or when a
 * name's diff does not come back whole, the files already read are not a
 * finished tree.
 */
const withUntracked = async (
  $: EngineInterface,
  root: string,
  tracked: string,
): Promise<{ ok: true; text: string } | { ok: false; gap: string }> => {
  // -z: NUL-separated and never quoted, so a name with a space, a quote or
  // non-ASCII characters comes back as it is on disk instead of skipped.
  const others = await runGit($, ['ls-files', '-z', '--others', '--exclude-standard'], root)
  if (others?.isStdoutTruncated) return { ok: false, gap: DIFF_TOO_BIG }
  if (others === undefined || others.exitCode !== 0) return { ok: false, gap: SCAN_UNREAD }
  const names = splitNul(others.stdout)
  const capped = names.length > UNTRACKED_LIMIT
  const chunks = [tracked]
  let scanned = 0
  for (const path of names.slice(0, UNTRACKED_LIMIT)) {
    // --no-index exits 1 when the two sides differ, which is the point here.
    const one = await runGit(
      $,
      ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-prefix', '--no-index', '--', '/dev/null', path],
      root,
    )
    const taken = takeDiff(one, true)
    if (!taken.ok) return { ok: false, gap: one?.isStdoutTruncated ? DIFF_TOO_BIG : partialFilesLine(scanned, names.length) }
    if (!capped) chunks.push(taken.stdout)
    scanned += 1
  }
  if (capped) return { ok: false, gap: partialFilesLine(scanned, names.length) }

  return { ok: true, text: chunks.join('\n') }
}

/**
 * What was committed during the turn: `<start>..HEAD`. Still unborn means
 * nothing was committed. The same revision at both ends is an empty range.
 * Anything else we cannot compute is not a clean tree.
 */
const committedText = async (
  $: EngineInterface,
  root: string,
  head: Head,
  before: Baseline,
): Promise<{ ok: true; text: string } | { ok: false; gap: string }> => {
  if (head.kind === 'unread') return { ok: false, gap: head.gap === DIFF_TOO_BIG ? DIFF_TOO_BIG : RANGE_UNREAD }
  if (head.kind === 'unborn') return before.unborn === true ? { ok: true, text: '' } : { ok: false, gap: RANGE_UNREAD }
  if (before.startRev === undefined) return { ok: false, gap: RANGE_UNREAD }
  if (before.startRev === head.rev) return { ok: true, text: '' }
  const diff = takeDiff(await runGit($, diffArgs([`${before.startRev}..HEAD`]), root))
  if (!diff.ok) return { ok: false, gap: diff.gap === DIFF_TOO_BIG ? DIFF_TOO_BIG : RANGE_UNREAD }

  return { ok: true, text: diff.stdout }
}

/** The worktree now: tracked changes plus untracked files, up to the cap. Not a repository is `ok: false` with no gap. */
const readTree = async ($: EngineInterface): Promise<Read> => {
  const root = await repoRoot($)
  if (root === undefined) return { ok: false, files: [] }
  const head = await readHead($, root)
  const tracked = await trackedText($, root, head)
  if (!tracked.ok) return { ok: false, files: [], startRev: tracked.startRev, unborn: tracked.unborn, gap: tracked.gap }
  const full = await withUntracked($, root, tracked.text)
  if (!full.ok) return { ok: false, files: [], startRev: tracked.startRev, unborn: tracked.unborn, gap: full.gap }

  return { ok: true, files: parseAddedLines(full.text), startRev: tracked.startRev, unborn: tracked.unborn }
}

/**
 * The worktree, plus `<start>..HEAD` for lines a commit during the turn
 * took out of the worktree diff. Either half failing drops the files:
 * a card built from the half we have would look finished.
 */
const readEnd = async ($: EngineInterface, before: Baseline): Promise<Read> => {
  const root = await repoRoot($)
  if (root === undefined) return { ok: false, files: [] }
  const head = await readHead($, root)
  const tracked = await trackedText($, root, head)
  if (!tracked.ok) return { ok: false, files: [], gap: tracked.gap }
  const full = await withUntracked($, root, tracked.text)
  if (!full.ok) return { ok: false, files: [], gap: full.gap }
  const committed = await committedText($, root, head, before)
  if (!committed.ok) return { ok: false, files: [], gap: committed.gap }

  return { ok: true, files: parseAddedLines(`${full.text}\n${committed.text}`) }
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
    const line =
      now === null
        ? undefined
        : now.gap === DIFF_TOO_BIG
          ? withTurnOff(now.gap)
          : (now.gap ?? statusLine(now.hits.length + now.overflow))
    $.ui.status(line)
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
    const scan = await readTree($)
    await update($, baseline, prev => {
      if (!scan.ok) {
        // A failed diff is not an empty tree, and a cut-off diff is not the
        // new baseline. This turn has nothing complete to compare against.
        return {
          turnId: e.turnId,
          ok: false,
          seen: prev?.ok ? prev.seen : {},
          startRev: scan.startRev ?? prev?.startRev,
          unborn: scan.unborn ?? prev?.unborn,
          gap: scan.gap,
        }
      }

      return { ...baselineOf(e.turnId, { ok: true, files: scan.files }), startRev: scan.startRev, unborn: scan.unborn }
    })

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
      if (before === null) {
        await update($, card, () => null)
        await showStatus($)

        return done
      }
      const after = await readEnd($, before)
      const gap = !before.ok || !after.ok ? (after.gap ?? before.gap) : undefined
      if (gap !== undefined || !before.ok || !after.ok) {
        // No list from a prefix, and no quiet "nothing found" when the read
        // did not finish. Outside a repository there is no gap, so no line.
        await update($, card, () => (gap === undefined ? null : { turnId: e.turnId, hits: [], overflow: 0, gap }))
        await showStatus($)

        return done
      }
      const found = cardFor(before, { ok: true, files: after.files })
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
    if (!showing || showing.gap !== undefined) return next(e)

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
