import type { EngineInterface, Register } from 'claude-code'

import {
  CLEARED,
  decide,
  focusKey,
  NO_ROOT,
  parseNameStatusZ,
  parseStageZ,
  planStamps,
  safeGitPath,
  SAVED_FAIL,
  showLine,
  splitNul,
  stampsFor,
  statusLine,
  touchedPaths,
  toStored,
  verdicts,
  watchesFromStore,
  type FileStamp,
  type SpecialKind,
} from './focus'

/** One git read. Past this, the read is a failure and the turn is not held. */
const GIT_TIMEOUT_MS = 3000

type Run = { exitCode: number; stdout: string; isStdoutTruncated?: boolean }

type Snapshot =
  | { ok: true; head: string; stamps: readonly FileStamp[]; hints: readonly { path: string; kind: SpecialKind }[] }
  | { ok: false }

type Baseline = { turnId: string; paths: readonly string[]; snapshot: Snapshot }

type Loaded = { root: string; paths: string[] } | { gap: true }

/**
 * The baseline for one `register` call. Created inside `register` and passed
 * in, because `$` may only be handed to a top-level helper.
 *
 * `epoch` moves at the start of every main-loop turn. A status write from
 * the previous turn checks it after git returns, so a slow read cannot paint
 * that turn's line over the next one.
 */
type Memory = { baseline: Baseline | undefined; epoch: number }

const pathspec = (path: string): string => (path === '.' ? '.' : path.replace(/\/+$/, ''))

/** `git rev-parse --verify HEAD`. Undefined when this repo has no commit yet. */
const readHead = async ($: EngineInterface, root: string): Promise<string | undefined> => {
  const found = await runGit($, ['rev-parse', '--verify', 'HEAD'], root)
  if (!gitOk(found)) return undefined
  const sha = found.stdout.trim()
  if (!/^[0-9a-f]{40}$/i.test(sha) && !/^[0-9a-f]{64}$/i.test(sha)) return undefined

  return sha
}

const runGit = async ($: EngineInterface, argv: readonly string[], cwd: string): Promise<Run | undefined> =>
  $.process.run(['git', '-c', 'core.quotePath=false', ...argv], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)

const gitOk = (found: Run | undefined): found is Run =>
  found !== undefined && found.exitCode === 0 && found.isStdoutTruncated !== true

const load = async ($: EngineInterface): Promise<Loaded> => {
  const root = await $.session.root().catch(() => undefined)
  if (typeof root !== 'string') return { gap: true }
  const key = focusKey(root)
  if (key === undefined) return { gap: true }
  const raw = await $.store.get(key).catch(() => undefined)

  return { root, paths: watchesFromStore(raw) }
}

const save = async ($: EngineInterface, root: string, paths: readonly string[]): Promise<void> => {
  const key = focusKey(root)
  if (key === undefined) throw new Error('no project root')
  await $.store.set(key, toStored(paths))
}

const clearSaved = async ($: EngineInterface, root: string): Promise<void> => {
  const key = focusKey(root)
  if (key === undefined) throw new Error('no project root')
  await $.store.delete(key)
}

/** True when this directory is a git work tree. A failure is false, not a throw. */
const insideGit = async ($: EngineInterface, root: string): Promise<boolean> => {
  const found = await runGit($, ['rev-parse', '--is-inside-work-tree'], root)

  return gitOk(found) && found.stdout.trim() === 'true'
}

/** False only when the path is confirmed missing. A failed check does not claim that. */
const pathExists = async ($: EngineInterface, root: string, path: string): Promise<boolean> => {
  const base = root.replace(/[\\/]+$/, '')
  const rel = path === '.' ? '' : path.replace(/\/+$/, '')
  const full = rel === '' ? base : `${base}/${rel}`

  return $.fs.exists(full).catch(() => true)
}

/**
 * Watched paths that differ from HEAD right now, plus untracked files under
 * the list, plus the HEAD this read compared against. Read-only. Any failed,
 * slow, or cut-off git read is `{ ok: false }`.
 */
const shoot = async ($: EngineInterface, root: string, watches: readonly string[]): Promise<Snapshot> => {
  const specs = watches.map(pathspec).filter(safeGitPath)
  const [head, diff, others, stage] = await Promise.all([
    readHead($, root),
    runGit($, ['diff', '--name-status', '-z', '-M', '--relative', '--no-color', '--no-ext-diff', 'HEAD'], root),
    runGit($, ['ls-files', '-z', '--others', '--exclude-standard'], root),
    runGit($, ['ls-files', '-z', '--stage', '--', ...specs], root),
  ])
  if (head === undefined || !gitOk(diff) || !gitOk(others) || !gitOk(stage)) return { ok: false }
  const specials = parseStageZ(stage.stdout)
  const plan = planStamps(parseNameStatusZ(diff.stdout), splitNul(others.stdout), watches, specials)
  if (!plan.ok) return { ok: false }
  const hashing = [...plan.present, ...plan.untracked]
  const hashes = new Map<string, string>()
  if (hashing.length > 0) {
    const hashed = await runGit($, ['hash-object', '--', ...hashing], root)
    if (!gitOk(hashed)) return { ok: false }
    const lines = hashed.stdout.split('\n')
    if (lines.at(-1) === '') lines.pop()
    if (lines.length !== hashing.length || lines.some(line => line === '' || /\s/.test(line))) return { ok: false }
    hashing.forEach((path, index) => {
      const line = lines[index]
      if (line !== undefined) hashes.set(path, line)
    })
  }
  const stamps = stampsFor(plan, hashes)
  if (stamps === undefined) return { ok: false }
  const hints = specials
    .filter(one => watches.some(watch => pathspec(watch) === one.path))
    .map(one => ({ path: one.path, kind: one.kind }))

  return { ok: true, head, stamps, hints }
}

/**
 * Paths a commit between the turn's start HEAD and the current HEAD changed.
 * Undefined when that diff cannot be read: the caller shows nothing, because
 * a clean work tree would otherwise be reported untouched.
 */
const committedPaths = async (
  $: EngineInterface,
  root: string,
  start: string,
  watches: readonly string[],
): Promise<string[] | undefined> => {
  const specs = watches.map(pathspec).filter(safeGitPath)
  const found = await runGit(
    $,
    ['diff', '--name-status', '-z', '-M', '--relative', '--no-color', '--no-ext-diff', start, 'HEAD', '--', ...specs],
    root,
  )
  if (!gitOk(found)) return undefined
  const changes = parseNameStatusZ(found.stdout)
  if (changes.some(change => !safeGitPath(change.path))) return undefined

  return changes.map(change => change.path)
}

const missingAmong = async ($: EngineInterface, root: string, paths: readonly string[]): Promise<string[]> => {
  const missing: string[] = []
  for (const path of paths) {
    if (!(await pathExists($, root, path))) missing.push(path)
  }

  return missing
}

const replyFor = async ($: EngineInterface, args: string): Promise<string> => {
  const found = await load($)
  if ('gap' in found) return NO_ROOT
  const decision = decide(args, found.root)
  if (decision.type === 'reject') return decision.text
  if (decision.type === 'clear') {
    try {
      await clearSaved($, found.root)
    } catch {
      return SAVED_FAIL
    }
    $.ui.status(undefined)

    return CLEARED
  }
  const paths = decision.type === 'set' ? decision.paths : found.paths
  if (decision.type === 'set') {
    try {
      await save($, found.root, paths)
    } catch {
      return SAVED_FAIL
    }
    $.ui.status(undefined)
  }
  if (paths.length === 0) return showLine(paths, [], true)
  const [missing, git] = await Promise.all([missingAmong($, found.root, paths), insideGit($, found.root)])

  return showLine(paths, missing, git)
}

/** A main-loop turn is starting. The previous line comes down. The baseline is this moment's tree. */
const beginTurn = async ($: EngineInterface, turnId: string, memory: Memory): Promise<void> => {
  memory.epoch += 1
  const epoch = memory.epoch
  memory.baseline = undefined
  $.ui.status(undefined)
  const found = await load($)
  if (memory.epoch !== epoch) return
  if ('gap' in found || found.paths.length === 0) return
  const snapshot = await shoot($, found.root, found.paths)
  if (memory.epoch !== epoch) return
  memory.baseline = { turnId, paths: found.paths, snapshot }
}

/**
 * The turn's answer is already decided. This only draws the line. A failed
 * read, a changed list, or a baseline that did not land draws nothing.
 */
const endTurn = async ($: EngineInterface, turnId: string, memory: Memory): Promise<void> => {
  const epoch = memory.epoch
  const baseline = memory.baseline
  memory.baseline = undefined
  const quiet = (): void => {
    if (memory.epoch === epoch) $.ui.status(undefined)
  }
  if (baseline === undefined || baseline.turnId !== turnId || !baseline.snapshot.ok) {
    quiet()

    return
  }
  const found = await load($)
  if (memory.epoch !== epoch) return
  if ('gap' in found || found.paths.join('\0') !== baseline.paths.join('\0')) {
    quiet()

    return
  }
  const after = await shoot($, found.root, found.paths)
  if (memory.epoch !== epoch) return
  if (!after.ok) {
    quiet()

    return
  }
  let changed = touchedPaths(baseline.snapshot.stamps, after.stamps)
  if (baseline.snapshot.head !== after.head) {
    const committed = await committedPaths($, found.root, baseline.snapshot.head, found.paths)
    if (memory.epoch !== epoch) return
    if (committed === undefined) {
      quiet()

      return
    }
    changed = [...new Set([...changed, ...committed])]
  }
  if (memory.epoch !== epoch) return
  $.ui.status(statusLine(verdicts(found.paths, changed, after.hints)))
}

export const register: Register = on => {
  const memory: Memory = { baseline: undefined, epoch: 0 }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'wait-focus',
        description: 'Name up to three paths and see if a turn touched them',
        argumentHint: 'src/auth/ package.json',
      })
    } catch {
      // The list can still load. The command is registered again on the next start.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /** `/wait-focus` answers here and does not start a turn. The text it returns is the reply. */
  on('command.run', { command: 'wait-focus' }, async ($, e) => {
    try {
      return { text: await replyFor($, typeof e.args === 'string' ? e.args : '') }
    } catch {
      return { text: SAVED_FAIL }
    }
  })

  /** A main-loop turn starts. A subagent's turn is not one of yours, and does not clear the line. */
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await beginTurn($, e.turnId, memory)
      } catch {
        memory.baseline = undefined
        $.ui.status(undefined)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * The turn's answer goes back first. The status line is bookkeeping after
   * that, and a git failure stays inside this hook.
   */
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    try {
      await endTurn($, e.turnId, memory)
    } catch {
      memory.baseline = undefined
      $.ui.status(undefined)
    }

    return done
  }).catch(($, e, next) => next(e))
}
