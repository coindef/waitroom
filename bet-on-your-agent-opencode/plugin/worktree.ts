import { spawn } from 'node:child_process'

import { parseStatus } from '../../bet-on-your-agent/hooks/bet.ts'

/** Past this many changed files, hashing the worktree costs more than it tells us. */
const WORKTREE_LIMIT = 500

const runGit = (argv: readonly string[], cwd: string): Promise<{ exitCode: number; stdout: string } | undefined> =>
  new Promise(resolve => {
    const child = spawn('git', [...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let settled = false
    const finish = (value: { exitCode: number; stdout: string } | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(undefined)
    }, 15000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    // stderr is drained so a noisy git cannot fill the pipe and stall.
    child.stderr.on('data', () => {})
    child.on('error', () => finish(undefined))
    child.on('close', code => finish({ exitCode: code ?? 1, stdout }))
  })

/**
 * Each path git sees changed, mapped to a content hash.
 *
 * Undefined outside a repository, or when git does not answer. This is the
 * fallback for a bash or `apply_patch` turn when `session.diff` cannot be read.
 */
export const scanWorktree = async (root: string): Promise<Record<string, string> | undefined> => {
  if (root === '') return undefined
  const top = await runGit(['rev-parse', '--show-toplevel'], root)
  if (!top || top.exitCode !== 0) return undefined
  const repo = top.stdout.trim()
  if (repo === '') return undefined
  const status = await runGit(
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    repo,
  )
  if (!status || status.exitCode !== 0) return undefined
  const entries = parseStatus(status.stdout)
  if (entries.length > WORKTREE_LIMIT) return undefined
  const present = entries.filter(one => !one.isDeleted).map(one => one.path)
  let hashes: string[] = []
  if (present.length > 0) {
    const hashed = await runGit(['hash-object', '--', ...present], repo)
    if (!hashed || hashed.exitCode !== 0) return undefined
    hashes = hashed.stdout.split('\n')
  }
  const look: Record<string, string> = {}
  for (const one of entries) {
    look[one.path] = one.isDeleted ? 'deleted' : (hashes[present.indexOf(one.path)] ?? '')
  }

  return look
}
