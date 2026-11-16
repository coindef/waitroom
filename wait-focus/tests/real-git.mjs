/**
 * Real git, outside `claude plugin test` (that runner cannot spawn a process).
 *
 * Each case leaves the work tree matching the new HEAD. A read that only diffs
 * the work tree against the current HEAD, which is what 674234 does, reports
 * the watched path untouched. `git diff <start> HEAD -- <path>` reports it.
 *
 * Run: node wait-focus/tests/real-git.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIFF = ['diff', '--name-status', '-z', '-M', '--relative', '--no-color', '--no-ext-diff']

const git = (cwd, args) =>
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
    },
  })

const worktree = cwd => git(cwd, [...DIFF, 'HEAD'])

const range = (cwd, start, path) => git(cwd, [...DIFF, start, 'HEAD', '--', path])

const head = cwd => git(cwd, ['rev-parse', '--verify', 'HEAD']).trim()

const commit = (cwd, message) => {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', message])
}

const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'wait-focus-'))
  git(cwd, ['init', '-b', 'main'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test'])
  writeFileSync(join(cwd, 'package.json'), 'one\n')
  commit(cwd, 'base')

  return cwd
}

/** 674234 compares only these two work-tree diffs. Both empty means untouched. */
const untouchedOn674234 = (before, after) => before === '' && after === ''

const check = (name, path, scene) => {
  const cwd = repo()
  try {
    scene.before?.(cwd)
    const start = head(cwd)
    const before = worktree(cwd)
    scene.during(cwd)
    const after = worktree(cwd)
    const moved = range(cwd, start, path)
    const oldSaysUntouched = untouchedOn674234(before, after)
    const rangeSaysTouched = moved.includes(path)
    if (!oldSaysUntouched || !rangeSaysTouched || head(cwd) === start) {
      throw new Error(
        `${name}: oldUntouched=${oldSaysUntouched} rangeTouched=${rangeSaysTouched} moved=${head(cwd) !== start} range=${JSON.stringify(moved)}`,
      )
    }
    console.log(`${name}\tFAILS on 674234 (untouched)\trange ${JSON.stringify(moved)}`)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

check('edit-and-commit', 'package.json', {
  during(cwd) {
    writeFileSync(join(cwd, 'package.json'), 'two\n')
    commit(cwd, 'edit')
  },
})

check('new-file', 'src/new.ts', {
  during(cwd) {
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/new.ts'), 'hi\n')
    commit(cwd, 'add')
  },
})

check('several-commits', 'package.json', {
  during(cwd) {
    writeFileSync(join(cwd, 'package.json'), 'two\n')
    commit(cwd, 'first')
    writeFileSync(join(cwd, 'package.json'), 'three\n')
    commit(cwd, 'second')
  },
})

check('amend', 'package.json', {
  during(cwd) {
    writeFileSync(join(cwd, 'package.json'), 'two\n')
    git(cwd, ['add', 'package.json'])
    git(cwd, ['commit', '--amend', '-m', 'amended'])
  },
})

check('reset', 'package.json', {
  before(cwd) {
    writeFileSync(join(cwd, 'package.json'), 'two\n')
    commit(cwd, 'forward')
  },
  during(cwd) {
    git(cwd, ['reset', '--hard', 'HEAD~1'])
  },
})

check('rebase', 'package.json', {
  before(cwd) {
    writeFileSync(join(cwd, 'package.json'), 'two\n')
    commit(cwd, 'main moves the watched file')
    git(cwd, ['checkout', '-b', 'side', 'HEAD~1'])
    writeFileSync(join(cwd, 'README.md'), 'note\n')
    commit(cwd, 'side only adds a readme')
  },
  during(cwd) {
    git(cwd, ['rebase', 'main'])
  },
})

console.log('6 real-git cases: 674234 reports untouched, git diff <start> HEAD reports the path')
