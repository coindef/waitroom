/**
 * Runs the printed `git commit -F` command for real.
 *
 * `claude plugin test` cannot spawn a process, so this file is not named
 * `*.test.ts`. From the repository root:
 *
 *   node --experimental-strip-types wait-ship/tests/commit-path.check.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyCommandFor, pathFromCwd } from '../hooks/ship.ts'

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
}

const git = (cwd: string, args: readonly string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' })

const initRepo = (root: string) => {
  git(root, ['init', '-q'])
  writeFileSync(join(root, 'README.md'), 'hi\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-q', '-m', 'init'])
}

/** Stage one file, write the draft, and run the exact command the receipt prints. */
const commitWithPrinted = (root: string, cwd: string, shipDir: string, subject: string) => {
  writeFileSync(join(root, 'a.ts'), `export const a = ${JSON.stringify(subject)}\n`)
  git(root, ['add', 'a.ts'])
  const repoPath = `${shipDir}/COMMIT_EDITMSG.txt`
  mkdirSync(join(root, shipDir), { recursive: true })
  writeFileSync(join(root, repoPath), `${subject}\n`)
  const printed = applyCommandFor('commit', pathFromCwd(root, cwd, repoPath))
  execFileSync('sh', ['-c', printed], { cwd, env, stdio: 'inherit' })
  const logged = git(root, ['log', '-1', '--format=%s']).trim()
  if (logged !== subject) throw new Error(`commit subject ${JSON.stringify(logged)} from ${printed}`)
  console.log(`ok  ${printed}`)
}

const root = mkdtempSync(join(tmpdir(), 'wait-ship-commit-'))
try {
  initRepo(root)
  const sub = join(root, 'packages', 'app')
  mkdirSync(sub, { recursive: true })

  commitWithPrinted(root, sub, '.waitroom/ship', 'feat: from a subfolder')
  commitWithPrinted(root, root, 'my drafts', 'feat: drafts folder with a space')
  commitWithPrinted(root, sub, 'my drafts', 'feat: subfolder and a space')
  commitWithPrinted(root, sub, "my 'drafts", 'feat: a quote in the folder')
} finally {
  rmSync(root, { recursive: true, force: true })
}
