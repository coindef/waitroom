import type { EngineInterface, Register } from 'claude-code'

import {
  CLEARED,
  decide,
  focusKey,
  NO_ROOT,
  parseNameStatusZ,
  planStamps,
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
} from './focus'

/** One git read. Past this, the read is a failure and the turn is not held. */
const GIT_TIMEOUT_MS = 3000

type Run = { exitCode: number; stdout: string; isStdoutTruncated?: boolean }

type Snapshot = { ok: true; stamps: readonly FileStamp[] } | { ok: false }

type Baseline = { turnId: string; paths: readonly string[]; snapshot: Snapshot }

type Loaded = { root: string; paths: string[] } | { gap: true }

/**
 * The baseline for one `register` call. Created inside `register` and passed
 * in, because `$` may only be handed to a top-level helper.
 */
type Memory = { baseline: Baseline | undefined }

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
 * the list. Read-only. Any failed, slow, or cut-off git read is `{ ok: false }`.
 */
const shoot = async ($: EngineInterface, root: string, watches: readonly string[]): Promise<Snapshot> => {
  const [diff, others] = await Promise.all([
    runGit($, ['diff', '--name-status', '-z', '-M', '--relative', '--no-color', '--no-ext-diff', 'HEAD'], root),
    runGit($, ['ls-files', '-z', '--others', '--exclude-standard'], root),
  ])
  if (!gitOk(diff) || !gitOk(others)) return { ok: false }
  const plan = planStamps(parseNameStatusZ(diff.stdout), splitNul(others.stdout), watches)
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

  return { ok: true, stamps }
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
  memory.baseline = undefined
  $.ui.status(undefined)
  const found = await load($)
  if ('gap' in found || found.paths.length === 0) return
  memory.baseline = { turnId, paths: found.paths, snapshot: await shoot($, found.root, found.paths) }
}

/**
 * The turn's answer is already decided. This only draws the line. A failed
 * read, a changed list, or a baseline that did not land draws nothing.
 */
const endTurn = async ($: EngineInterface, turnId: string, memory: Memory): Promise<void> => {
  const baseline = memory.baseline
  memory.baseline = undefined
  if (baseline === undefined || baseline.turnId !== turnId || !baseline.snapshot.ok) {
    $.ui.status(undefined)

    return
  }
  const found = await load($)
  if ('gap' in found || found.paths.join('\0') !== baseline.paths.join('\0')) {
    $.ui.status(undefined)

    return
  }
  const after = await shoot($, found.root, found.paths)
  if (!after.ok) {
    $.ui.status(undefined)

    return
  }
  $.ui.status(statusLine(verdicts(found.paths, touchedPaths(baseline.snapshot.stamps, after.stamps))))
}

export const register: Register = on => {
  const memory: Memory = { baseline: undefined }

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
