/**
 * HEAD moved during the turn and the work tree matches the new HEAD.
 * `wait-focus/tests/real-git.mjs` runs these six scenes in a real repository.
 * Each range string below is the stdout of `git diff <start> HEAD -- <path>`.
 * On 674234 the hook only diffs the work tree against the current HEAD, so
 * every one of these reads untouched.
 *
 * Requires `claude plugin test`.
 */

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/repo'
const HEAD_A = 'a'.repeat(40)
const HEAD_B = 'b'.repeat(40)

const finish = (turnId: string) =>
  ({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' }) as const

const begin = (turnId: string) => ({ text: 'edit it', turnId }) as const

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Scene = {
  args: string
  range: string
  line: string
}

const scene = async ($: Parameters<Parameters<typeof test>[1]>[0], on: On, one: Scene) => {
  const argvs: string[][] = []
  const said: (string | undefined)[] = []
  let head = HEAD_A
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    const argv = e.argv.join(' ')
    if (e.argv[0] !== 'git') throw new Error(`not git: ${argv}`)
    if (argv.includes('rev-parse') && argv.includes('--is-inside-work-tree')) return ran('true\n')
    if (argv.includes('rev-parse') && argv.includes('--verify') && argv.includes('HEAD')) return ran(`${head}\n`)
    if (argv.includes('diff')) {
      const dash = e.argv.indexOf('--')
      const headAt = e.argv.indexOf('HEAD')
      if (headAt !== -1 && dash > headAt) return ran(one.range)

      return ran('')
    }
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes('hash-object')) return ran('')

    return ran('', 1)
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wait-focus', args: one.args } as never)
  await $.turn.start(begin('turn-head'))
  head = HEAD_B
  const answer = await $.turn.complete(finish('turn-head'))
  expect(answer.text).toBe('done')
  expect(said.at(-1)).toBe(one.line)
  expect(said.at(-1)).not.toContain('untouched')
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
    one.args,
  ])
}

test('an edit committed in the turn is touched', async ($, on) => {
  await scene($, on, { args: 'package.json', range: 'M\0package.json\0', line: 'package.json touched' })
})

test('a new file committed in the turn is touched', async ($, on) => {
  await scene($, on, { args: 'src/new.ts', range: 'A\0src/new.ts\0', line: 'src/new.ts touched' })
})

test('several commits in the turn are touched', async ($, on) => {
  await scene($, on, { args: 'package.json', range: 'M\0package.json\0', line: 'package.json touched' })
})

test('an amend in the turn is touched', async ($, on) => {
  await scene($, on, { args: 'package.json', range: 'M\0package.json\0', line: 'package.json touched' })
})

test('a reset in the turn is touched', async ($, on) => {
  await scene($, on, { args: 'package.json', range: 'M\0package.json\0', line: 'package.json touched' })
})

test('a rebase in the turn is touched', async ($, on) => {
  await scene($, on, { args: 'package.json', range: 'M\0package.json\0', line: 'package.json touched' })
})
