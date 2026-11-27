import type { EngineInterface, Register } from 'claude-code'

import {
  GIT_TIMEOUT_MS,
  NOTHING_TO_MARK,
  PROGRESS_UNREAD,
  SAVED_FAIL,
  SEEN_KEY,
  SEEN_LINE,
  SKIP_KEY,
  SKIP_LINE,
  USAGE,
  branchLogLine,
  commentText,
  defaultBranchName,
  parseBlameTime,
  parseChoreCommand,
  parseGrep,
  parseMergedBranches,
  parseOriginHead,
  pickDeadBranch,
  pickTodo,
  recordsFromStore,
  statusFor,
  todoLogLine,
  toStored,
  todoId,
  type TodoHit,
} from './chore'

type Run = { exitCode: number; stdout: string; isStdoutTruncated?: boolean }

type Shown = { todo: TodoHit | undefined; branch: string | undefined }

type Memory = { asking: Shown | undefined; answered: Shown | undefined }

type IdRead = { ok: false } | { ok: true; value: string[] }

const runGit = async ($: EngineInterface, argv: readonly string[], cwd: string): Promise<Run | undefined> =>
  $.process.run(['git', '-c', 'core.quotePath=false', ...argv], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)

const gitOk = (found: Run | undefined): found is Run =>
  found !== undefined && found.exitCode === 0 && found.isStdoutTruncated !== true

const insideGit = async ($: EngineInterface, root: string): Promise<boolean> => {
  const found = await runGit($, ['rev-parse', '--is-inside-work-tree'], root)

  return gitOk(found) && found.stdout.trim() === 'true'
}

const readTodos = async ($: EngineInterface, root: string): Promise<TodoHit[] | undefined> => {
  const found = await runGit($, ['grep', '-n', '-I', '-e', 'TODO', '-e', 'FIXME'], root)
  if (found === undefined || found.isStdoutTruncated === true || found.exitCode > 1) return undefined
  if (found.exitCode === 1) return []
  const rows = parseGrep(found.stdout)
  const hits: TodoHit[] = []
  for (const row of rows) {
    const blamed = await runGit($, ['blame', '--line-porcelain', '-L', `${row.line},${row.line}`, '--', row.path], root)
    if (!gitOk(blamed)) continue
    const seconds = parseBlameTime(blamed.stdout)
    if (seconds === undefined) continue
    hits.push({ path: row.path, line: row.line, text: commentText(row.raw), at: seconds * 1000 })
  }

  return hits
}

const readDeadBranch = async ($: EngineInterface, root: string): Promise<string | undefined> => {
  const head = await runGit($, ['symbolic-ref', 'refs/remotes/origin/HEAD'], root)
  if (!gitOk(head)) return undefined
  const ref = parseOriginHead(head.stdout)
  if (ref === undefined) return undefined
  const currentRun = await runGit($, ['branch', '--show-current'], root)
  const current = gitOk(currentRun) ? currentRun.stdout.trim() : undefined
  const merged = await runGit($, ['branch', '--merged', ref], root)
  if (!gitOk(merged)) return undefined

  return pickDeadBranch(parseMergedBranches(merged.stdout, defaultBranchName(ref), current))
}

const readIds = async ($: EngineInterface, key: string): Promise<IdRead> => {
  try {
    const raw = await $.store.get(key)
    const records = recordsFromStore(raw)
    if (records === 'invalid') return { ok: true, value: [] }

    return { ok: true, value: records ?? [] }
  } catch {
    return { ok: false }
  }
}

const writeIds = async ($: EngineInterface, key: string, ids: readonly string[]): Promise<void> => {
  await $.store.set(key, toStored(ids))
}

/** A main-loop turn started: put the TODO text, and a merged branch name, on the status line. */
const ask = async ($: EngineInterface, memory: Memory): Promise<void> => {
  memory.asking = undefined
  const root = await $.session.root().catch(() => undefined)
  if (typeof root !== 'string' || root.trim() === '') {
    $.ui.status(undefined)

    return
  }
  if (!(await insideGit($, root))) {
    $.ui.status(undefined)

    return
  }
  const [todos, branch, seen, skipped] = await Promise.all([
    readTodos($, root),
    readDeadBranch($, root),
    readIds($, SEEN_KEY),
    readIds($, SKIP_KEY),
  ])
  if (!seen.ok || !skipped.ok) {
    $.ui.status(undefined)

    return
  }
  const todo = todos === undefined ? undefined : pickTodo(todos, seen.value, skipped.value)
  const shown: Shown = { todo, branch }
  if (todo === undefined && branch === undefined) {
    $.ui.status(undefined)

    return
  }
  memory.asking = shown
  $.ui.status(statusFor(todo?.text, branch))
}

/** The turn ended: clear the status line and log file, line, age, and the suggested delete. */
const answer = async ($: EngineInterface, memory: Memory): Promise<void> => {
  const shown = memory.asking
  memory.asking = undefined
  $.ui.status(undefined)
  if (shown === undefined) return
  memory.answered = shown
  const now = await $.clock.now().catch(() => Date.now())
  if (shown.todo !== undefined) $.ui.log(todoLogLine(shown.todo, now))
  if (shown.branch !== undefined) $.ui.log(branchLogLine(shown.branch))
}

const mark = async ($: EngineInterface, memory: Memory, kind: 'seen' | 'skip'): Promise<string> => {
  const todo = memory.answered?.todo
  if (todo === undefined) return NOTHING_TO_MARK
  const id = todoId(todo)
  const seen = await readIds($, SEEN_KEY)
  const skipped = await readIds($, SKIP_KEY)
  if (!seen.ok || !skipped.ok) return PROGRESS_UNREAD
  if (kind === 'seen') {
    const nextSeen = seen.value.includes(id) ? seen.value : [...seen.value, id]
    const nextSkipped = skipped.value.filter(item => item !== id)
    await writeIds($, SEEN_KEY, nextSeen)
    if (nextSkipped.length !== skipped.value.length) await writeIds($, SKIP_KEY, nextSkipped)

    return SEEN_LINE
  }
  if (seen.value.includes(id)) return SEEN_LINE
  const nextSkipped = skipped.value.includes(id) ? skipped.value : [...skipped.value, id]
  await writeIds($, SKIP_KEY, nextSkipped)

  return SKIP_LINE
}

export const register: Register = on => {
  const memory: Memory = { asking: undefined, answered: undefined }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'chore', description: 'Mark the last TODO seen or skip it', argumentHint: 'seen · skip' })
    } catch {
      // The line can still show. The command is registered again on the next start.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await ask($, memory)
      } catch {
        memory.asking = undefined
        $.ui.status(undefined)
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    try {
      await answer($, memory)
    } catch {
      memory.asking = undefined
      $.ui.status(undefined)
    }

    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'chore' }, async ($, e) => {
    const command = parseChoreCommand(e.args)
    try {
      if (command === 'invalid') return { text: USAGE }

      return { text: await mark($, memory, command) }
    } catch {
      return { text: SAVED_FAIL }
    }
  })
}
