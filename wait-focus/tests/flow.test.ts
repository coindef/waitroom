/**
 * The loop through the engine: `/wait-focus` sets, shows, refuses, and clears;
 * after a main-loop turn the status line says which watched paths the turn
 * touched. Git is answered by the test. Nothing is blocked, written, or fetched.
 *
 * Requires `claude plugin test`.
 */

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { TOO_MANY } from '../hooks/focus'

const ROOT = '/repo'

const finish = (turnId: string, extra: { agentId?: string } = {}) =>
  ({
    turnId,
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  }) as const

const begin = (turnId: string, agentId?: string) =>
  ({ text: 'edit the auth code', turnId, ...(agentId === undefined ? {} : { agentId }) }) as const

const HEAD_A = 'a'.repeat(40)

type Git = {
  /** When true, rev-parse and diff and ls-files fail the way they do outside a work tree. */
  notRepo?: boolean
  /** `git rev-parse --verify HEAD`. The turn records this, then reads it again at the end. */
  head?: string
  nameStatus: string
  /** `git diff <start> HEAD -- <paths>` when HEAD moved. Empty means that commit touched nothing watched. */
  rangeStatus?: string
  /** The range diff exits non-zero. The line must stay blank, not say untouched. */
  rangeFail?: boolean
  /** `git ls-files -z --stage` for symlink (120000) and submodule (160000) paths. */
  stage?: string
  untracked: string[]
  hashes: Record<string, string>
  /** `diff` throws. The hook has to finish the turn anyway. */
  throwDiff?: boolean
  /** `diff` stdout is marked truncated. */
  truncateDiff?: boolean
  /** Paths `fs.exists` reports as missing. */
  missing?: string[]
  /** The next working-tree diff waits until `release` is called. `held` resolves once that wait has started. */
  holdNextDiff?: boolean
  held?: Promise<void>
  entered?: () => void
  release?: () => void
}

const ran = (stdout: string, exitCode = 0, truncated = false) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: truncated, isStderrTruncated: false },
})

const engineBottom = (on: On, git: Git, store: Record<string, unknown> = {}) => {
  git.head ??= HEAD_A
  git.rangeStatus ??= ''
  git.stage ??= ''
  const said: (string | undefined)[] = []
  const argvs: string[][] = []
  const cwds: (string | undefined)[] = []
  const timeouts: (number | undefined)[] = []
  const fetched: string[] = []
  const wrote: string[] = []
  const modeled: string[] = []
  mock.store(on, store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({
    value: !(git.missing ?? []).some(path => e.path === `${ROOT}/${path.replace(/\/+$/, '')}`),
  }))
  on('fs.write', ($, e) => {
    wrote.push(e.path)
    throw new Error(`wait-focus writes no file: ${e.path}`)
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-focus opens no connection: ${e.url}`)
  })
  on('model.complete', () => {
    modeled.push('complete')
    throw new Error('wait-focus calls no model')
  })
  on('process.run', async ($, e) => {
    argvs.push([...e.argv])
    cwds.push(e.init?.cwd)
    timeouts.push(e.init?.timeoutMs)
    const argv = e.argv.join(' ')
    if (e.argv[0] !== 'git') throw new Error(`not git: ${argv}`)
    if (/\b(commit|push|pull|add|reset|checkout|merge|rebase|fetch|clone|stash|rm|clean|update-index)\b/.test(argv)) {
      throw new Error(`not a read-only git read: ${argv}`)
    }
    if (git.notRepo && (argv.includes('rev-parse') || argv.includes('diff') || argv.includes('ls-files'))) {
      return ran('fatal: not a git repository\n', 128)
    }
    if (argv.includes('rev-parse')) {
      if (argv.includes('--is-inside-work-tree')) return ran('true\n')
      if (argv.includes('--verify') && argv.includes('HEAD')) return ran(`${git.head ?? HEAD_A}\n`)

      return ran('', 1)
    }
    if (argv.includes('diff')) {
      if (git.throwDiff) throw new Error('git diff failed')
      if (!argv.includes('--name-status') || !argv.includes('-z') || !argv.includes('-M')) {
        throw new Error(`diff is not name-status -z -M: ${argv}`)
      }
      const headAt = e.argv.indexOf('HEAD')
      const dashAt = e.argv.indexOf('--')
      const isRange = headAt !== -1 && dashAt > headAt
      if (isRange) {
        if (git.rangeFail) return ran('fatal: bad revision\n', 128)

        return ran(git.rangeStatus ?? '')
      }
      if (git.holdNextDiff) {
        git.holdNextDiff = false
        git.entered?.()
        await new Promise<void>(resolve => {
          git.release = resolve
        })
      }

      return ran(git.nameStatus, 0, git.truncateDiff === true)
    }
    if (argv.includes('ls-files')) {
      if (!e.argv.includes('-z')) throw new Error(`ls-files without -z: ${argv}`)
      if (e.argv.includes('--stage')) return ran(git.stage ?? '')

      return ran(git.untracked.map(path => `${path}\0`).join(''))
    }
    if (argv.includes('hash-object')) {
      const paths = e.argv.slice(e.argv.indexOf('--') + 1)
      const lines = paths.map(path => {
        const hash = git.hashes[path]
        if (hash === undefined) throw new Error(`no hash for ${path}`)

        return hash
      })

      return ran(`${lines.join('\n')}\n`)
    }

    return ran('', 1)
  })

  return { said, argvs, cwds, timeouts, fetched, wrote, modeled, store }
}

const shown = (said: readonly (string | undefined)[]) => said.filter((text): text is string => text !== undefined)

const quiet = (said: readonly (string | undefined)[]) => {
  for (const text of shown(said)) expect(text).not.toMatch(/touched|untouched/)
}

test('a folder the turn edits is touched, and a file it leaves alone is untouched', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said, argvs, cwds, timeouts, fetched, wrote, modeled } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const set = await $.command.run({ command: 'wait-focus', args: 'src/auth/ package.json' } as never)
  expect(set.text).toBe('watching src/auth/ · package.json')

  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBeUndefined()
  git.nameStatus = 'M\0src/auth/login.ts\0'
  git.hashes['src/auth/login.ts'] = 'abc'
  const answer = await $.turn.complete(finish('turn-1'))
  expect(answer.text).toBe('done')
  expect(said.at(-1)).toBe('src/auth/ touched · package.json untouched')
  expect(argvs.every(argv => argv[0] === 'git')).toBe(true)
  expect(cwds.every(cwd => cwd === ROOT)).toBe(true)
  expect(timeouts.every(timeout => timeout === 3000)).toBe(true)
  expect(fetched).toEqual([])
  expect(wrote).toEqual([])
  expect(modeled).toEqual([])
})

test('a turn that changes nothing under the list says untouched', async ($, on) => {
  const git: Git = {
    nameStatus: 'M\0src/auth/login.ts\0',
    untracked: [],
    hashes: { 'src/auth/login.ts': 'abc' },
  }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'src/auth/ package.json' } as never)
  await $.turn.start(begin('turn-still'))
  await $.turn.complete(finish('turn-still'))
  expect(said.at(-1)).toBe('src/auth/ untouched · package.json untouched')
})

test('a delete and a rename count, and an unrelated file does not', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'src/a.ts pkg.json' } as never)
  await $.turn.start(begin('turn-del'))
  git.nameStatus = 'D\0pkg.json\0'
  await $.turn.complete(finish('turn-del'))
  expect(said.at(-1)).toBe('src/a.ts untouched · pkg.json touched')

  git.nameStatus = ''
  await $.turn.start(begin('turn-ren'))
  git.nameStatus = 'R100\0src/a.ts\0src/b.ts\0'
  git.hashes['src/b.ts'] = 'def'
  await $.turn.complete(finish('turn-ren'))
  expect(said.at(-1)).toBe('src/a.ts touched · pkg.json untouched')
})

test('a file that was already dirty counts when its hash changes, and not when it does not', async ($, on) => {
  const git: Git = { nameStatus: 'M\0package.json\0', untracked: [], hashes: { 'package.json': 'aaa' } }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-same'))
  await $.turn.complete(finish('turn-same'))
  expect(said.at(-1)).toBe('package.json untouched')

  await $.turn.start(begin('turn-edit'))
  git.hashes['package.json'] = 'bbb'
  await $.turn.complete(finish('turn-edit'))
  expect(said.at(-1)).toBe('package.json touched')
})

test('an untracked file under a watched folder counts', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'src/auth/' } as never)
  await $.turn.start(begin('turn-new'))
  git.untracked = ['src/auth/new.ts']
  git.hashes['src/auth/new.ts'] = 'hhh'
  await $.turn.complete(finish('turn-new'))
  expect(said.at(-1)).toBe('src/auth/ touched')
})

test('a path that is not on disk yet is watched, and stays untouched until a turn creates it', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {}, missing: ['src/missing.ts'] }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const set = await $.command.run({ command: 'wait-focus', args: 'src/missing.ts' } as never)
  expect(set.text).toBe('watching src/missing.ts (not on disk yet)')
  await $.turn.start(begin('turn-miss'))
  await $.turn.complete(finish('turn-miss'))
  expect(said.at(-1)).toBe('src/missing.ts untouched')

  await $.turn.start(begin('turn-born'))
  git.missing = []
  git.nameStatus = 'A\0src/missing.ts\0'
  git.hashes['src/missing.ts'] = 'new'
  await $.turn.complete(finish('turn-born'))
  expect(said.at(-1)).toBe('src/missing.ts touched')
})

test('a path outside the repo is refused and the list already stored stays', async ($, on) => {
  const { said } = engineBottom(on, { nameStatus: '', untracked: [], hashes: {} })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  const outside = await $.command.run({ command: 'wait-focus', args: '../secret' } as never)
  expect(outside.text).toBe('../secret is outside this repo · name a path inside it')
  const absolute = await $.command.run({ command: 'wait-focus', args: '/etc/passwd' } as never)
  expect(absolute.text).toBe('/etc/passwd is outside this repo · name a path inside it')
  const shownList = await $.command.run({ command: 'wait-focus', args: '' } as never)
  expect(shownList.text).toBe('watching package.json')
  expect(said.at(-1)).toBeUndefined()
})

test('a glob is refused and the list already stored stays', async ($, on) => {
  engineBottom(on, { nameStatus: '', untracked: [], hashes: {} })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  const glob = await $.command.run({ command: 'wait-focus', args: 'src/**/*.ts' } as never)
  expect(glob.text).toBe('src/**/*.ts looks like a glob · name a file or folder, like src/auth/ or package.json')
  const star = await $.command.run({ command: 'wait-focus', args: 'src/auth/*' } as never)
  expect(star.text).toBe('src/auth/* looks like a glob · name a file or folder, like src/auth/ or package.json')
  const shownList = await $.command.run({ command: 'wait-focus', args: '' } as never)
  expect(shownList.text).toBe('watching package.json')
})

test('a fourth path is refused with a clear message and the previous list stays', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  const refused = await $.command.run({ command: 'wait-focus', args: 'a b c d' } as never)
  expect(refused.text).toBe(TOO_MANY)
  const shownList = await $.command.run({ command: 'wait-focus', args: '' } as never)
  expect(shownList.text).toBe('watching package.json')
})

test('outside a git repository the list is saved, the reply says so, and a turn stays quiet', async ($, on) => {
  const { said } = engineBottom(on, { notRepo: true, nameStatus: '', untracked: [], hashes: {} })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const set = await $.command.run({ command: 'wait-focus', args: 'src/auth/' } as never)
  expect(set.text).toBe('watching src/auth/ · not a git repo, so a turn here stays quiet')
  await $.turn.start(begin('turn-nogit'))
  const answer = await $.turn.complete(finish('turn-nogit'))
  expect(answer.text).toBe('done')
  quiet(said)
})

test('a git failure fails open: the turn still finishes, and the line does not guess', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {}, throwDiff: true }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-fail'))
  git.throwDiff = false
  git.nameStatus = 'M\0package.json\0'
  git.hashes['package.json'] = 'abc'
  const answer = await $.turn.complete(finish('turn-fail'))
  expect(answer.text).toBe('done')
  quiet(said)
})

test('a diff that throws at the end of the turn does not guess and does not fail the turn', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-end'))
  git.throwDiff = true
  const answer = await $.turn.complete(finish('turn-end'))
  expect(answer.text).toBe('done')
  quiet(said)
})

test('truncated git output fails open', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-cut'))
  git.truncateDiff = true
  git.nameStatus = 'M\0package.json\0'
  git.hashes['package.json'] = 'abc'
  const answer = await $.turn.complete(finish('turn-cut'))
  expect(answer.text).toBe('done')
  quiet(said)
})

test('a subagent turn does not clear the line', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-main'))
  git.nameStatus = 'M\0package.json\0'
  git.hashes['package.json'] = 'abc'
  await $.turn.complete(finish('turn-main'))
  expect(said.at(-1)).toBe('package.json touched')
  git.nameStatus = ''
  await $.turn.start(begin('turn-sub', 'worker'))
  await $.turn.complete(finish('turn-sub', { agentId: 'worker' }))
  expect(said.at(-1)).toBe('package.json touched')
})

test('a commit during the turn is touched, and a range diff that fails shows nothing', async ($, on) => {
  const git: Git = { head: HEAD_A, nameStatus: '', rangeStatus: '', untracked: [], hashes: {} }
  const { said, argvs } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-commit'))
  git.head = 'b'.repeat(40)
  git.rangeStatus = 'M\0package.json\0'
  const answer = await $.turn.complete(finish('turn-commit'))
  expect(answer.text).toBe('done')
  expect(said.at(-1)).toBe('package.json touched')
  const range = argvs.find(argv => argv.includes(HEAD_A) && argv.includes('HEAD') && argv.includes('--'))
  expect(range?.slice(range.indexOf('diff'))).toEqual([
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--relative',
    '--no-color',
    '--no-ext-diff',
    HEAD_A,
    'HEAD',
    '--',
    'package.json',
  ])

  git.head = HEAD_A
  git.rangeStatus = ''
  await $.turn.start(begin('turn-bad'))
  git.head = 'c'.repeat(40)
  git.rangeFail = true
  const failed = await $.turn.complete(finish('turn-bad'))
  expect(failed.text).toBe('done')
  expect(said.at(-1)).toBeUndefined()
})

test('a watched symlink or submodule says so, instead of a blank line', async ($, on) => {
  const git: Git = {
    nameStatus: '',
    untracked: [],
    hashes: {},
    stage: `120000 ${'d'.repeat(40)} 0\tlink.json\0`,
  }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'link.json package.json' } as never)
  await $.turn.start(begin('turn-link'))
  await $.turn.complete(finish('turn-link'))
  expect(said.at(-1)).toBe('link.json is a symlink · package.json untouched')

  git.stage = `160000 ${'e'.repeat(40)} 0\tvendor\0`
  git.nameStatus = 'M\0vendor\0'
  await $.command.run({ command: 'wait-focus', args: 'vendor' } as never)
  await $.turn.start(begin('turn-sub'))
  await $.turn.complete(finish('turn-sub'))
  expect(said.at(-1)).toBe('vendor is a submodule')
})

test('a slow read from the previous turn does not paint over the next one', async ($, on) => {
  const git: Git = { nameStatus: '', untracked: [], hashes: {} }
  const { said } = engineBottom(on, git)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  await $.turn.start(begin('turn-old'))
  git.holdNextDiff = true
  git.held = new Promise<void>(resolve => {
    git.entered = resolve
  })
  git.nameStatus = 'M\0package.json\0'
  git.hashes['package.json'] = 'abc'
  const pending = $.turn.complete(finish('turn-old'))
  await git.held
  await $.turn.start(begin('turn-new'))
  git.release?.()
  await pending
  expect(shown(said)).not.toContain('package.json touched')
  expect(said.at(-1)).toBeUndefined()
  await $.turn.complete(finish('turn-new'))
  expect(said.at(-1)).toBe('package.json untouched')
})

test('/wait-focus clear takes the line down', async ($, on) => {
  const { said } = engineBottom(on, { nameStatus: '', untracked: [], hashes: {} })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const empty = await $.command.run({ command: 'wait-focus', args: '' } as never)
  expect(empty.text).toBe('/wait-focus src/auth/ or package.json · up to 3')
  await $.command.run({ command: 'wait-focus', args: 'package.json' } as never)
  const cleared = await $.command.run({ command: 'wait-focus', args: 'clear' } as never)
  expect(cleared.text).toBe('cleared')
  expect(said.at(-1)).toBeUndefined()
  const after = await $.command.run({ command: 'wait-focus', args: '' } as never)
  expect(after.text).toBe('/wait-focus src/auth/ or package.json · up to 3')
})
