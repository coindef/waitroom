import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { GITHUB, OPENAI } from './fake'

/**
 * SE-1..SE-4. Git is answered with the exit codes and patches a real
 * repository produces (the test runner cannot spawn a process). Each case
 * fails on the hooks that treat a partial read as a finished tree.
 */

const ROOT = '/repo'
const TITLE = 'Possible secrets in what this turn wrote'
const TOO_BIG = 'diff too big · /wait-secret turns it off'
const UNREAD = "couldn't finish scanning this turn's changes"
const RANGE_UNREAD = "couldn't scan what this turn committed"
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const ran = (stdout: string, exitCode = 0, truncated = false) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: truncated, isStderrTruncated: false },
})

const added = (path: string, lines: readonly string[]) =>
  [`diff --git ${path} ${path}`, '--- /dev/null', `+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join(
    '\n',
  ) + '\n'

const sha = (digit: string) => digit.repeat(40)

type Answer = ReturnType<typeof ran>

const harness = (on: On, answer: (argv: readonly string[], scan: number) => Answer) => {
  const said: (string | undefined)[] = []
  let scan = 0
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    said.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const line = argv.join(' ')
    if (argv[0] !== 'git' || /\b(commit|push|pull|add|reset|checkout|merge|rebase|fetch|clone|stash|rm)\b/.test(line)) {
      throw new Error(`not a read-only git read: ${line}`)
    }
    if (line.includes('--show-toplevel')) {
      scan += 1

      return ran(`${ROOT}\n`)
    }

    return answer(argv, scan)
  })
  on('config.list', () => ({ value: [] }))
  on('config.set', () => ({ value: true }))

  return { said }
}

const shown = (said: readonly (string | undefined)[]) => said.filter((text): text is string => text !== undefined)

const BAND = { component: 'AbovePrompt', requestId: 'above-prompt', viewport: { columns: 140, rows: 40 } } as const

const BAND_PROPS = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 135,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
} as const

const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: 'wait-secret',
    surface: 'terminal',
    ...BAND,
    props: BAND_PROPS,
  })

const finish = (turnId: string) => ({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' }) as const

const nul = (names: readonly string[]) => names.map(name => `${name}\0`).join('')

test("a failed diff against HEAD is not an empty tree, and a repository with no commit still scans what is staged", async ($, on) => {
  const oldDiff = added('old.ts', [`k = "${GITHUB}"`])
  const staged = [oldDiff, oldDiff + added('new.ts', [`k = "${OPENAI}"`])]
  let stagedAt = 0
  let phase: 'unborn' | 'flaky' = 'unborn'
  let headDiffs = 0
  const { said } = harness(on, argv => {
    const line = argv.join(' ')
    if (argv.includes('rev-parse')) return phase === 'unborn' ? ran('', 1) : ran(`${sha('a')}\n`)
    if (argv.includes('symbolic-ref')) return phase === 'unborn' ? ran('refs/heads/master\n') : ran('', 1)
    if (argv.includes('hash-object')) return ran(`${EMPTY_TREE}\n`)
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes('--no-index')) return ran('', 128)
    if (argv.some(part => part.includes('..'))) return ran('')
    if (line.includes('--cached')) return ran(staged[Math.min(stagedAt++, staged.length - 1)] ?? '')
    if (argv.includes('diff') && argv.includes('HEAD')) {
      headDiffs += 1
      if (phase === 'flaky' && headDiffs === 1) throw new Error('timeout')
      if (phase === 'unborn') return ran('', 128)

      return ran(added('kept.ts', [`k = "${OPENAI}"`]))
    }
    if (argv.includes('diff')) return ran('')

    throw new Error(`unexpected git: ${line}`)
  })

  await $.turn.start({ text: 'stage a key', turnId: 'unborn' })
  const unborn = await $.turn.complete(finish('unborn'))
  expect(unborn.text).toBe('done')
  expect(said.at(-1)).toBe('1 possible secret')
  const band = await mountBand($)
  expect(await band.find({ text: 'new.ts:1  sk-…3f9a  (OpenAI key?)' })).toBeDefined()
  expect(await band.find({ text: 'ghp_…b4e1' })).toBeUndefined()
  await band.unmount()

  // The start read fails (timeout). The secret was already staged; the end read
  // can see it. That must not become "this turn wrote it".
  phase = 'flaky'
  headDiffs = 0
  await $.turn.start({ text: 'again', turnId: 'flaky' })
  await $.turn.complete(finish('flaky'))
  expect(said.at(-1)).toBe(UNREAD)
  const quiet = await mountBand($)
  expect(await quiet.find({ text: TITLE })).toBeUndefined()
  expect(await quiet.find({ text: 'sk-…3f9a' })).toBeUndefined()
  await quiet.unmount()
})

test('past a hundred new files the scan stops and says so, and a short read says where it stopped', async ($, on) => {
  const many = [...Array.from({ length: 100 }, (_, index) => `a${String(index).padStart(2, '0')}.txt`), 'z-secret.ts']
  const few = ['a.ts', 'b.ts', 'c.ts']
  const exact = Array.from({ length: 100 }, (_, index) => `b${String(index).padStart(2, '0')}.txt`)
  const opened: string[] = []
  let scan = 0
  const { said } = harness(on, (argv, at) => {
    scan = at
    const line = argv.join(' ')
    if (argv.includes('rev-parse')) return ran(`${sha('b')}\n`)
    if (argv.includes('symbolic-ref')) return ran('', 1)
    if (argv.includes('hash-object')) return ran(`${EMPTY_TREE}\n`)
    if (argv.some(part => part.includes('..'))) return ran('')
    if (argv.includes('diff') && argv.includes('HEAD')) return ran('')
    if (argv.includes('ls-files')) {
      if (at === 2) return ran(nul(many))
      if (at === 4) return ran(nul(few))
      if (at === 6) return ran(nul(exact))

      return ran('')
    }
    if (argv.includes('--no-index')) {
      const path = argv.at(-1) ?? ''
      opened.push(path)
      if (path === 'z-secret.ts' || path === 'a00.txt' || path === 'b99.txt') {
        return ran(added(path, [`const key = "${OPENAI}"`]), 1)
      }
      if (path === 'b.ts') return ran('', 128)
      if (path === 'a.ts') return ran(added(path, [`const key = "${OPENAI}"`]), 1)
      if (path === '') return ran('', 128)

      return ran(added(path, ['const a = 1']), 1)
    }
    if (argv.includes('diff')) return ran('')

    throw new Error(`unexpected git on scan ${scan}: ${line}`)
  })

  await $.turn.start({ text: 'many files', turnId: 'many' })
  await $.turn.complete(finish('many'))
  expect(said.at(-1)).toBe('scanned 100 of 101 new files')
  expect(opened).toEqual(many.slice(0, 100))
  const band = await mountBand($)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  expect(await band.find({ text: 'sk-…3f9a' })).toBeUndefined()
  await band.unmount()

  opened.length = 0
  await $.turn.start({ text: 'one diff fails', turnId: 'short' })
  await $.turn.complete(finish('short'))
  expect(said.at(-1)).toBe('scanned 1 of 3 new files')
  expect(opened).toEqual(['a.ts', 'b.ts'])
  const stopped = await mountBand($)
  expect(await stopped.find({ text: TITLE })).toBeUndefined()
  expect(await stopped.find({ text: 'sk-…3f9a' })).toBeUndefined()
  await stopped.unmount()

  opened.length = 0
  await $.turn.start({ text: 'exactly the cap', turnId: 'exact' })
  await $.turn.complete(finish('exact'))
  expect(said.at(-1)).toBe('1 possible secret')
  expect(opened).toEqual(exact)
  const full = await mountBand($)
  expect(await full.find({ text: 'b99.txt:1  sk-…3f9a  (OpenAI key?)' })).toBeDefined()
  await full.unmount()
})

test('a diff cut off before the end is not listed, and that prefix is not the next baseline', async ($, on) => {
  const secretDiff = added('a.ts', [`const key = "${OPENAI}"`])
  const replies: { stdout: string; truncated: boolean }[] = [
    { stdout: '', truncated: false },
    { stdout: secretDiff, truncated: true },
    { stdout: '', truncated: true },
    { stdout: secretDiff, truncated: false },
  ]
  let diffs = 0
  const { said } = harness(on, argv => {
    const line = argv.join(' ')
    if (argv.includes('rev-parse')) return ran(`${sha('c')}\n`)
    if (argv.includes('symbolic-ref')) return ran('', 1)
    if (argv.includes('hash-object')) return ran(`${EMPTY_TREE}\n`)
    if (argv.some(part => part.includes('..'))) return ran('')
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes('--no-index')) return ran('', 128)
    if (argv.includes('diff') && argv.includes('HEAD')) {
      const reply = replies[Math.min(diffs, replies.length - 1)]
      diffs += 1

      return ran(reply?.stdout ?? '', 0, reply?.truncated ?? false)
    }
    if (argv.includes('diff')) return ran('')

    throw new Error(`unexpected git: ${line}`)
  })

  await $.turn.start({ text: 'big', turnId: 'cut' })
  await $.turn.complete(finish('cut'))
  expect(said.at(-1)).toBe(TOO_BIG)
  const cut = await mountBand($)
  expect(await cut.find({ text: TITLE })).toBeUndefined()
  expect(await cut.find({ text: 'sk-…3f9a' })).toBeUndefined()
  await cut.unmount()

  // The secret was already in the tree at the start; only the cap hid it.
  // Once the full diff is readable it must not be reported as this turn's.
  await $.turn.start({ text: 'now it fits', turnId: 'later' })
  await $.turn.complete(finish('later'))
  expect(said.at(-1)).not.toBe('1 possible secret')
  const later = await mountBand($)
  expect(await later.find({ text: 'sk-…3f9a' })).toBeUndefined()
  await later.unmount()
})

test('a secret committed during the turn is still flagged, and an unreadable range is not called clean', async ($, on) => {
  const heads = [sha('1'), sha('2'), sha('3'), sha('4')]
  let verifies = 0
  const secretDiff = added('secret.ts', [`const key = "${OPENAI}"`])
  const { said } = harness(on, argv => {
    const line = argv.join(' ')
    if (argv.includes('rev-parse')) {
      const next = heads[Math.min(verifies, heads.length - 1)] ?? sha('1')
      verifies += 1

      return ran(`${next}\n`)
    }
    if (argv.includes('symbolic-ref')) return ran('', 1)
    if (argv.includes('hash-object')) return ran(`${EMPTY_TREE}\n`)
    if (argv.includes('ls-files')) return ran('')
    if (argv.includes('--no-index')) return ran('', 128)
    const range = argv.find(part => part.includes('..'))
    if (range !== undefined) {
      if (range.startsWith(sha('1'))) return ran(secretDiff)
      if (range.startsWith(sha('3'))) return ran('', 128)

      return ran('')
    }
    if (argv.includes('diff') && argv.includes('HEAD') && argv.some(part => heads.includes(part))) {
      const from = argv.find(part => heads.includes(part)) ?? ''
      if (from === sha('1')) return ran(secretDiff)
      if (from === sha('3')) return ran('', 128)

      return ran('')
    }
    if (argv.includes('diff')) return ran('')

    throw new Error(`unexpected git: ${line}`)
  })

  await $.turn.start({ text: 'commit it', turnId: 'committed' })
  const committed = await $.turn.complete(finish('committed'))
  expect(committed.text).toBe('done')
  expect(said.at(-1)).toBe('1 possible secret')
  const band = await mountBand($)
  expect(await band.find({ text: 'secret.ts:1  sk-…3f9a  (OpenAI key?)' })).toBeDefined()
  expect(await band.find({ text: OPENAI })).toBeUndefined()
  await band.unmount()

  await $.turn.start({ text: 'range fails', turnId: 'norange' })
  await $.turn.complete(finish('norange'))
  expect(said.at(-1)).toBe(RANGE_UNREAD)
  const missed = await mountBand($)
  expect(await missed.find({ text: TITLE })).toBeUndefined()
  await missed.unmount()
})
