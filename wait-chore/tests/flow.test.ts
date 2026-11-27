/**
 * The loop through the engine: a TODO on the status line while a main-loop
 * turn runs, file/line/age and a suggested `git branch -d` logged when it
 * ends, `/chore seen` and `/chore skip` in the plugin store. Git is answered
 * by the test. Nothing is written to the repo, deleted, fetched, or sent to
 * a model.
 *
 * Requires `claude plugin test`.
 */

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { mutatingGitArgv, NOTHING_TO_MARK, SEEN_LINE, SKIP_LINE, todoId, USAGE } from '../hooks/chore'

const ROOT = '/repo'
const NOW = Date.UTC(2026, 10, 27, 16, 0, 0)
const OLD_TIME = 1609459200 // 2021-01-01
const NEW_TIME = 1735689600 // 2025-01-01

const finish = (turnId: string, extra: { isAborted?: boolean; agentId?: string } = {}) =>
  ({
    turnId,
    answer: 'done',
    durationMs: 1000,
    isAborted: extra.isAborted === true,
    reason: extra.isAborted === true ? 'aborted' : 'answer',
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
  }) as const

const begin = (turnId: string, agentId?: string) =>
  ({ text: 'fix the build', turnId, ...(agentId === undefined ? {} : { agentId }) }) as never

const blame = (seconds: number, path: string, line: number, raw: string): string =>
  [
    `abc123 ${line} ${line} 1`,
    'author A',
    'author-mail <a@b.c>',
    `author-time ${seconds}`,
    'author-tz +0000',
    'committer A',
    `committer-time ${seconds}`,
    `filename ${path}`,
    `\t${raw}`,
    '',
  ].join('\n')

type Git = {
  notRepo?: boolean
  grep?: string
  grepExit?: number
  originHead?: string | null
  merged?: string
  current?: string
  blame?: Record<string, string>
  blameFail?: string[]
  grepFail?: boolean
  truncate?: boolean
  throwGit?: boolean
}

const ran = (stdout: string, exitCode = 0, truncated = false) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: truncated, isStderrTruncated: false },
})

const engineBottom = (on: On, git: Git = {}, store: Record<string, unknown> = {}) => {
  git.grep ??= 'src/old.ts:1:  // TODO: old work\nsrc/new.ts:4:  // FIXME: new work\n'
  git.blame ??= {
    'src/old.ts:1': blame(OLD_TIME, 'src/old.ts', 1, '  // TODO: old work'),
    'src/new.ts:4': blame(NEW_TIME, 'src/new.ts', 4, '  // FIXME: new work'),
  }
  if (git.originHead === undefined) git.originHead = 'refs/remotes/origin/develop\n'
  git.merged ??= '  leftover\n* develop\n  also-gone\n'
  git.current ??= 'develop'
  const said: (string | undefined)[] = []
  const logged: string[] = []
  const argvs: string[][] = []
  const cwds: (string | undefined)[] = []
  const timeouts: (number | undefined)[] = []
  const fetched: string[] = []
  const wrote: string[] = []
  const modeled: string[] = []
  mock.clock(on, { now: NOW })
  on('store.get', ($, e) => ({
    value: store[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(store[e.key])),
  }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]

    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('fs.write', ($, e) => {
    wrote.push(e.path)
    throw new Error(`wait-chore writes no file: ${e.path}`)
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-chore opens no connection: ${e.url}`)
  })
  on('model.complete', () => {
    modeled.push('complete')
    throw new Error('wait-chore calls no model')
  })
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    cwds.push(e.init?.cwd)
    timeouts.push(e.init?.timeoutMs)
    if (git.throwGit) throw new Error('git missing')
    const argv = e.argv
    const gitArg = argv[0] === 'git' ? argv.slice(1) : argv
    const args = gitArg[0] === '-c' ? gitArg.slice(2) : gitArg
    const cmd = args[0]
    if (cmd === 'rev-parse' && args.includes('--is-inside-work-tree')) {
      if (git.notRepo) return ran('false\n', 128)

      return ran('true\n')
    }
    if (cmd === 'grep') {
      if (git.grepFail) return ran('', 2)
      const exit = git.grepExit ?? (git.grep === '' ? 1 : 0)

      return ran(git.grep ?? '', exit, git.truncate === true)
    }
    if (cmd === 'blame') {
      const path = args.at(-1) ?? ''
      const lineFlag = args.find((part, i) => args[i - 1] === '-L') ?? ''
      const line = lineFlag.split(',')[0] ?? ''
      const key = `${path}:${line}`
      if ((git.blameFail ?? []).includes(key)) return ran('', 128)

      return ran(git.blame?.[key] ?? '', git.blame?.[key] === undefined ? 128 : 0)
    }
    if (cmd === 'symbolic-ref') {
      if (git.originHead === null) return ran('fatal: ref does not exist\n', 128)

      return ran(git.originHead ?? '', 0)
    }
    if (cmd === 'branch' && args.includes('--merged')) {
      return ran(git.merged ?? '')
    }
    if (cmd === 'branch' && args.includes('--show-current')) {
      return ran(`${git.current ?? ''}\n`)
    }

    throw new Error(`unexpected git: ${argv.join(' ')}`)
  })

  return { said, logged, argvs, cwds, timeouts, fetched, wrote, modeled, store }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

const chore = async ($: Engine, args: string): Promise<string> => {
  const result = await $.command.run({ command: 'chore', args, text: `/chore ${args}` } as never)

  return typeof result === 'object' && result !== null && 'text' in result ? String(result.text) : String(result)
}

test('the oldest TODO is on the status line during a turn, with a merged branch name', async ($, on) => {
  const { said, logged, fetched, modeled, wrote, argvs } = engineBottom(on)
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('old work · also-gone')
  expect(logged).toEqual([])

  await $.turn.complete(finish('turn-1'))
  expect(said.at(-1)).toBeUndefined()
  expect(logged).toEqual(['src/old.ts:1 · 5 years old', 'git branch -d also-gone'])
  expect(fetched).toEqual([])
  expect(modeled).toEqual([])
  expect(wrote).toEqual([])
  expect(argvs.some(mutatingGitArgv)).toBe(false)
  expect(argvs.some(argv => argv.includes('-d') || argv.includes('-D'))).toBe(false)
})

test('when there is only a TODO, the status line is only its text', async ($, on) => {
  const { said, logged } = engineBottom(on, { merged: '* develop\n', current: 'develop' })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('old work')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['src/old.ts:1 · 5 years old'])
})

test('when there is only a dead branch, the status line is the branch name', async ($, on) => {
  const { said, logged } = engineBottom(on, { grep: '', grepExit: 1 })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('also-gone')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['git branch -d also-gone'])
})

test('a missing origin/HEAD shows no dead-branch card and still shows a TODO', async ($, on) => {
  const { said, logged, argvs } = engineBottom(on, { originHead: null })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('old work')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['src/old.ts:1 · 5 years old'])
  expect(argvs.some(argv => argv.includes('--merged'))).toBe(false)
})

test('outside a git work tree the line stays clear', async ($, on) => {
  const { said, logged } = engineBottom(on, { notRepo: true })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.filter(line => line !== undefined)).toEqual([])
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual([])
})

test('a failed grep leaves the line clear', async ($, on) => {
  const { said, logged } = engineBottom(on, { grepFail: true, originHead: null })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.filter(line => line !== undefined)).toEqual([])
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual([])
})

test('a subagent turn neither asks nor answers', async ($, on) => {
  const { said, logged } = engineBottom(on)
  await start($)
  await $.turn.start(begin('sub-1', 'worker'))
  expect(said).toEqual([])
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('sub-1', { agentId: 'worker' }))
  expect(logged).toEqual([])
  expect(said.at(-1)).toBe('old work · also-gone')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['src/old.ts:1 · 5 years old', 'git branch -d also-gone'])
})

test('an interrupted turn still logs the file, line and age', async ($, on) => {
  const { logged } = engineBottom(on, { merged: '* develop\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1', { isAborted: true }))
  expect(logged).toEqual(['src/old.ts:1 · 5 years old'])
})

test('/chore seen persists, and the next wait shows the next oldest TODO', async ($, on) => {
  const { said, store } = engineBottom(on, { merged: '* develop\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(await chore($, 'seen')).toBe(SEEN_LINE)
  expect(store.seen).toEqual({ v: 1, ids: [todoId({ path: 'src/old.ts', line: 1, text: 'old work' })] })

  await $.turn.start(begin('turn-2'))
  expect(said.at(-1)).toBe('new work')
})

test('/chore skip persists, and a later wait can show that item once others are gone', async ($, on) => {
  const { said, store } = engineBottom(on, { merged: '* develop\n' })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  expect(await chore($, 'skip')).toBe(SKIP_LINE)
  expect(store.skipped).toEqual({ v: 1, ids: [todoId({ path: 'src/old.ts', line: 1, text: 'old work' })] })

  await $.turn.start(begin('turn-2'))
  expect(said.at(-1)).toBe('new work')
  await $.turn.complete(finish('turn-2'))
  expect(await chore($, 'seen')).toBe(SEEN_LINE)

  await $.turn.start(begin('turn-3'))
  expect(said.at(-1)).toBe('old work')
})

test('/chore with nothing shown writes nothing', async ($, on) => {
  const { store } = engineBottom(on, { notRepo: true })
  await start($)
  expect(await chore($, 'seen')).toBe(NOTHING_TO_MARK)
  expect(store).toEqual({})
})

test('unknown /chore args are usage, and s or d are not accepted', async ($, on) => {
  engineBottom(on)
  await start($)
  expect(await chore($, '')).toBe(USAGE)
  expect(await chore($, 's')).toBe(USAGE)
  expect(await chore($, 'd')).toBe(USAGE)
})

test('every git call is in the project root, times out in 3s, and is read-only', async ($, on) => {
  const { argvs, cwds, timeouts } = engineBottom(on)
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(cwds.every(cwd => cwd === ROOT)).toBe(true)
  expect(timeouts.every(ms => ms === 3000)).toBe(true)
  expect(argvs.length > 0).toBe(true)
  expect(argvs.some(mutatingGitArgv)).toBe(false)
  expect(argvs.some(argv => argv.includes('grep'))).toBe(true)
  expect(argvs.some(argv => argv.includes('blame'))).toBe(true)
  expect(argvs.some(argv => argv.includes('--merged'))).toBe(true)
  expect(argvs.some(argv => argv.includes('symbolic-ref'))).toBe(true)
})

test('the default branch for --merged is the origin/HEAD ref, not a hardcoded name', async ($, on) => {
  const { argvs } = engineBottom(on, { originHead: 'refs/remotes/origin/trunk\n', merged: '* trunk\n', current: 'trunk' })
  await start($)
  await $.turn.start(begin('turn-1'))
  const merged = argvs.find(argv => argv.includes('--merged'))
  expect(merged?.includes('refs/remotes/origin/trunk')).toBe(true)
  expect(merged?.includes('master') ?? false).toBe(false)
  expect(merged?.includes('main') ?? false).toBe(false)
})

test('the current branch is not suggested even when --merged lists it', async ($, on) => {
  const { said, logged } = engineBottom(on, {
    merged: '  leftover\n* leftover\n',
    current: 'leftover',
    grep: '',
    grepExit: 1,
  })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.filter(line => line !== undefined)).toEqual([])
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual([])
})

test('a branch checked out in another worktree is not suggested', async ($, on) => {
  const { said, logged } = engineBottom(on, {
    merged: '  leftover\n* develop\n+ also-gone\n',
    current: 'develop',
    grep: '',
    grepExit: 1,
  })
  await start($)
  await $.turn.start(begin('turn-1'))
  expect(said.at(-1)).toBe('leftover')
  await $.turn.complete(finish('turn-1'))
  expect(logged).toEqual(['git branch -d leftover'])
})

test('an unusual branch name is suggested in the quoted form', async ($, on) => {
  const { logged } = engineBottom(on, {
    merged: "  -oops\n  foo'bar\n* develop\n",
    current: 'develop',
    grep: '',
    grepExit: 1,
  })
  await start($)
  await $.turn.start(begin('turn-1'))
  await $.turn.complete(finish('turn-1'))
  // Alphabetical: -oops before foo'bar. Both need quoting.
  expect(logged).toEqual(["git branch -d -- '-oops'"])
})

test('the prompt goes through unchanged', async ($, on) => {
  engineBottom(on)
  await start($)
  const sent = await $.prompt.submit({ text: 'fix the build', wait: false, origin: { kind: 'composer' } } as never)
  expect(sent.text).toBe('fix the build')
})
