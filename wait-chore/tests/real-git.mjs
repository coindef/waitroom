/**
 * Real git, outside `claude plugin test` (that runner cannot spawn a process).
 *
 * Proves oldest-TODO selection from git grep + git blame, the --merged-only
 * dead-branch filter, the origin/HEAD fallback, and that this plugin's
 * suggested `git branch -d` is never run (the temp repo is unchanged by the
 * selection itself).
 *
 * Run: node wait-chore/tests/real-git.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const git = (cwd, args, extra = {}) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...extra.env,
    },
  })

const repo = (name, branch) => {
  const cwd = mkdtempSync(join(tmpdir(), name))
  git(cwd, ['init', '-b', branch])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  return cwd
}

const digest = cwd => {
  const files = execFileSync('bash', ['-lc', 'find . -type f -print0 | sort -z | xargs -0 sha256sum'], {
    cwd,
    encoding: 'utf8',
  })
  const refs = git(cwd, ['show-ref', '--heads'])
  return createHash('sha256').update(files).update(refs).digest('hex')
}

const parseGrep = stdout => {
  const rows = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const match = /^(.*?):(\d+):(.*)$/.exec(line)
    if (!match) continue
    rows.push({ path: match[1], line: Number(match[2]), raw: match[3] })
  }
  return rows
}

const commentText = raw => {
  const stripped = raw
    .replace(/^\s*\/\*+/, '')
    .replace(/^\s*\/\//, '')
    .replace(/^\s*#/, '')
    .replace(/\*\/\s*$/, '')
    .trim()
  const match = /^(?:.*?)(\bTODO\b|\bFIXME\b)\s*:?\s*(.*)$/.exec(stripped)
  if (!match) return stripped
  const rest = (match[2] ?? '').trim()
  return rest === '' ? match[1] : rest
}

const blameTime = porcelain => {
  const match = /^author-time (\d+)$/m.exec(porcelain)
  return match ? Number(match[1]) : undefined
}

const oldest = hits =>
  [...hits].sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))[0]

const check = (name, fn) => {
  try {
    fn()
    console.log(`${name}\tPASS`)
  } catch (err) {
    console.error(`${name}\tFAIL\t${err.message}`)
    process.exitCode = 1
  }
}

check('oldest-TODO from git grep + git blame', () => {
  const cwd = repo('wait-chore-todo-', 'develop')
  try {
    writeFileSync(join(cwd, 'old.ts'), '// TODO: old work\n')
    git(cwd, ['add', 'old.ts'])
    git(
      cwd,
      ['commit', '-m', 'old'],
      { env: { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } },
    )
    writeFileSync(join(cwd, 'new.ts'), '// FIXME: new work\n')
    git(cwd, ['add', 'new.ts'])
    git(
      cwd,
      ['commit', '-m', 'new'],
      { env: { GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' } },
    )
    const grep = git(cwd, ['grep', '-n', '-I', '-e', 'TODO', '-e', 'FIXME'])
    const hits = []
    for (const row of parseGrep(grep)) {
      const porcelain = git(cwd, ['blame', '--line-porcelain', '-L', `${row.line},${row.line}`, '--', row.path])
      const seconds = blameTime(porcelain)
      if (seconds === undefined) throw new Error(`no blame time for ${row.path}:${row.line}`)
      hits.push({ path: row.path, line: row.line, text: commentText(row.raw), at: seconds })
    }
    const picked = oldest(hits)
    if (!picked || picked.path !== 'old.ts' || picked.text !== 'old work') {
      throw new Error(`picked ${JSON.stringify(picked)} from ${JSON.stringify(hits)}`)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

check('dead branch from --merged only; origin/HEAD names the default; -d is not run', () => {
  const origin = mkdtempSync(join(tmpdir(), 'wait-chore-origin-'))
  const cwd = repo('wait-chore-merged-', 'develop')
  try {
    git(origin, ['init', '--bare', '-b', 'develop'])
    writeFileSync(join(cwd, 'README'), 'base\n')
    git(cwd, ['add', 'README'])
    git(cwd, ['commit', '-m', 'base'])
    git(cwd, ['remote', 'add', 'origin', origin])
    git(cwd, ['push', '-u', 'origin', 'develop'])
    git(cwd, ['remote', 'set-head', 'origin', 'develop'])
    git(cwd, ['checkout', '-b', 'leftover'])
    writeFileSync(join(cwd, 'extra.txt'), 'x\n')
    git(cwd, ['add', 'extra.txt'])
    git(cwd, ['commit', '-m', 'extra'])
    git(cwd, ['checkout', 'develop'])
    git(cwd, ['merge', '--no-ff', 'leftover', '-m', 'merge leftover'])
    git(cwd, ['push', 'origin', 'develop'])
    git(cwd, ['fetch', 'origin'])
    const before = digest(cwd)
    const head = git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim()
    if (head !== 'refs/remotes/origin/develop') throw new Error(`origin/HEAD is ${head}`)
    const merged = git(cwd, ['branch', '--merged', head])
    const names = merged
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => (line.startsWith('*') ? line.slice(1).trim() : line))
      .filter(name => name !== 'develop')
    if (!names.includes('leftover')) throw new Error(`merged list missing leftover: ${JSON.stringify(merged)}`)
    const after = digest(cwd)
    if (before !== after) throw new Error('repo changed without running a delete')
    const still = git(cwd, ['branch', '--list', 'leftover']).trim()
    if (!still.includes('leftover')) throw new Error('leftover was deleted; the plugin must only suggest git branch -d')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(origin, { recursive: true, force: true })
  }
})

check('when origin/HEAD is not set, there is no default branch to merge against', () => {
  const cwd = repo('wait-chore-nohead-', 'develop')
  try {
    writeFileSync(join(cwd, 'README'), 'base\n')
    git(cwd, ['add', 'README'])
    git(cwd, ['commit', '-m', 'base'])
    git(cwd, ['remote', 'add', 'origin', cwd])
    let failed = false
    try {
      git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    } catch {
      failed = true
    }
    if (!failed) throw new Error('expected symbolic-ref to fail when origin/HEAD is not set')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
