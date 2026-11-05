import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { GITHUB, OPENAI } from './fake'

/**
 * The whole loop through the engine: git answered by the test, the count on
 * the status line and the masked list only after a turn that wrote a line
 * that looks like a key, and the two actions — dismiss this turn, or turn it
 * off for good. Nothing is ever blocked, written or fetched.
 */

const ROOT = '/repo'
const TITLE = 'Possible secrets in what this turn wrote'

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const added = (path: string, lines: readonly string[]) =>
  [`diff --git ${path} ${path}`, '--- /dev/null', `+++ ${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join(
    '\n',
  ) + '\n'

type Repo = {
  root?: string
  /** Each `git diff HEAD` takes the next entry; the last one repeats. */
  diffs: string[]
  /** Untracked files the turn left, by name, with their `--no-index` diff. */
  untracked?: Record<string, string>
}

type Settings = { refuse?: string; set: { key: string; value: unknown }[] }

const engineBottom = (on: On, repo: Repo, settings: Settings = { set: [] }, store: Record<string, unknown> = {}) => {
  const said: (string | undefined)[] = []
  const argvs: string[][] = []
  const fetched: string[] = []
  const wrote: string[] = []
  let diffAt = 0
  mock.store(on, store)
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
    argvs.push([...e.argv])
    const argv = e.argv.join(' ')
    if (e.argv[0] !== 'git' || /\b(commit|push|pull|add|reset|checkout|merge|rebase|fetch|clone|stash|rm)\b/.test(argv)) {
      throw new Error(`not a read-only git read: ${argv}`)
    }
    if (argv.includes('--show-toplevel')) return repo.root === undefined ? ran('', 128) : ran(`${repo.root}\n`)
    if (argv.includes('ls-files')) {
      // Only -z output is NUL-separated and unquoted; anything else is a bug.
      if (!e.argv.includes('-z')) throw new Error(`ls-files without -z: ${argv}`)

      return ran(Object.keys(repo.untracked ?? {}).map(path => `${path}\0`).join(''))
    }
    if (argv.includes('--no-index')) {
      const one = repo.untracked?.[e.argv.at(-1) ?? '']

      return one === undefined ? ran('', 128) : ran(one, 1)
    }
    if (argv.includes('diff HEAD')) {
      const text = repo.diffs[Math.min(diffAt, Math.max(0, repo.diffs.length - 1))] ?? ''
      diffAt += 1

      return ran(text)
    }

    return ran('', 1)
  })
  on('fs.write', ($, e) => {
    wrote.push(e.path)
    throw new Error(`wait-secret writes no file: ${e.path}`)
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-secret opens no connection: ${e.url}`)
  })
  on('config.list', () => ({
    value: [
      {
        key: 'wait-secret.enabled',
        label: 'Flag likely secrets a turn wrote',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'wait-secret', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    if (settings.refuse !== undefined) return { deny: settings.refuse }
    settings.set.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return { said, argvs, fetched, wrote }
}

const shown = (said: readonly (string | undefined)[]) => said.filter(text => text !== undefined)

const BAND = { component: 'AbovePrompt', requestId: 'above-prompt', viewport: { columns: 140, rows: 40 } } as const

const bandProps = (isWorking: boolean, hasSurvey = false) =>
  ({ hasSurvey, isWorking, maxRows: 6, bodyColumns: 135, scroll: { offset: 0, bodyRows: 6 }, view: {} }) as const

const mountBand = ($: Engine, isWorking: boolean, hasSurvey = false) =>
  $.ui.mount({ plugin: 'wait-secret', surface: 'terminal', ...BAND, props: bandProps(isWorking, hasSurvey) })

const finish = (turnId: string) =>
  ({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' }) as const

test('a turn that writes a key: count once it ends, then a masked list; nothing blocked, written or fetched', async ($, on) => {
  const { said, argvs, fetched, wrote } = engineBottom(on, {
    root: ROOT,
    diffs: ['', added('src/client.ts', ['import x from "y"', `const key = "${OPENAI}"`])],
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'wire up the client', turnId: 'turn-1' })

  const waiting = await mountBand($, true)
  expect(await waiting.find({ text: TITLE })).toBeUndefined()
  await waiting.unmount()
  expect(shown(said)).toEqual([])

  const answer = await $.turn.complete(finish('turn-1'))
  expect(answer.text).toBe('done')
  expect(said.at(-1)).toBe('1 possible secret')

  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeDefined()
  expect(await band.find({ text: 'src/client.ts:2  sk-…3f9a  (OpenAI key?)' })).toBeDefined()
  expect(await band.find({ text: OPENAI })).toBeUndefined()
  const buttons = await band.findAll({ type: 'Button' })
  expect(buttons.map(one => one.key).sort()).toEqual(['disable', 'dismiss'])
  for (const button of buttons) expect(button.text).not.toMatch(/revert|undo|block|commit|upload|delete/i)
  await band.unmount()

  // The status line never names the kind.
  for (const text of shown(said)) expect(text).not.toMatch(/OpenAI|key\?|sk-/)
  expect(argvs.every(argv => argv[0] === 'git')).toBe(true)
  expect(fetched).toEqual([])
  expect(wrote).toEqual([])
})

test('an untracked file whose name has spaces and non-ASCII is still scanned', async ($, on) => {
  const name = 'notes/café key ☕.ts'
  const repo: Repo = { root: ROOT, diffs: [''], untracked: {} }
  const { said, argvs } = engineBottom(on, repo)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'jot it down', turnId: 'turn-1' })
  // The file appears during the turn: the baseline saw an empty tree.
  repo.untracked = {}
  repo.untracked[name] = [`diff --no-index /dev/null ${name}`, '--- /dev/null', `+++ ${name}\t`, '@@ -0,0 +1 @@', `+const key = "${OPENAI}"`].join('\n') + '\n'
  await $.turn.complete(finish('turn-1'))
  expect(said.at(-1)).toBe('1 possible secret')

  const band = await mountBand($, false)
  expect(await band.find({ text: `${name}:1  sk-…3f9a  (OpenAI key?)` })).toBeDefined()
  await band.unmount()
  expect(argvs.some(argv => argv.includes('ls-files') && argv.includes('-z'))).toBe(true)
  expect(argvs.some(argv => argv.at(-1) === name)).toBe(true)
})

test('a turn with no hit sets no count and draws nothing', async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, diffs: ['', added('src/a.ts', ['const a = 1'])] })
  await $.turn.start({ text: 'one', turnId: 'turn-clean' })
  await $.turn.complete(finish('turn-clean'))
  expect(shown(said)).toEqual([])
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test('a key already uncommitted before the turn, or marked ignore, is not flagged', async ($, on) => {
  const before = added('src/a.ts', [`k = "${OPENAI}"`])
  const after = added('src/a.ts', [`k = "${OPENAI}"`, `t = "${GITHUB}" // wait-secret: ignore`])
  const { said } = engineBottom(on, { root: ROOT, diffs: [before, after] })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))
  expect(shown(said)).toEqual([])
})

test('a .env file the turn wrote is read KEY=value', async ($, on) => {
  const { said } = engineBottom(on, {
    root: ROOT,
    diffs: ['', added('.env.local', ['PORT=3000', 'DB_PASS=' + 'Qm7' + 'Fake9Test' + 'Zt4x8Lw'])],
  })
  await $.turn.start({ text: 'one', turnId: 'turn-env' })
  await $.turn.complete(finish('turn-env'))
  expect(said.at(-1)).toBe('1 possible secret')
  const band = await mountBand($, false)
  expect(await band.find({ text: '.env.local:2  DB_PASS=…x8Lw  (env value?)' })).toBeDefined()
  await band.unmount()
})

test('Close puts the list and the count away; the next turn starts clean', async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, diffs: ['', added('a.ts', [`k="${OPENAI}"`, `g="${GITHUB}"`])] })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))
  expect(said.at(-1)).toBe('2 possible secrets')
  const band = await mountBand($, false)
  await band.press({ key: 'dismiss' })
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
  expect(said.at(-1)).toBeUndefined()

  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  expect(said.at(-1)).toBeUndefined()
})

test("Don't show again turns it off: later turns run no git and set no count", async ($, on) => {
  const settings: Settings = { set: [] }
  const { said, argvs } = engineBottom(on, { root: ROOT, diffs: ['', added('a.ts', [`k="${OPENAI}"`])] }, settings)
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))
  const band = await mountBand($, false)
  await band.press({ key: 'disable' })
  await band.unmount()
  expect(settings.set).toEqual([{ key: 'wait-secret.enabled', value: false }])

  const runs = argvs.length
  const lines = said.length
  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  await $.turn.complete(finish('turn-2'))
  expect(argvs).toHaveLength(runs)
  expect(shown(said.slice(lines))).toEqual([])
})

test('a refused settings write still keeps it off, and /wait-secret turns it back on', async ($, on) => {
  const settings: Settings = { refuse: 'managed', set: [] }
  engineBottom(on, { root: ROOT, diffs: [''] }, settings)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const off = await $.command.run({ command: 'wait-secret' } as never)
  expect(off.text).toBe('off · the setting did not change (managed) · kept off on this machine · /wait-secret turns it back on')
  settings.refuse = undefined
  const back = await $.command.run({ command: 'wait-secret' } as never)
  expect(back.text).toBe('on · a masked list once a turn writes something that looks like a key · /wait-secret turns it off')
})

test('outside a repository the turn stays silent', async ($, on) => {
  const { said } = engineBottom(on, { diffs: [added('a.ts', [`k="${OPENAI}"`])] })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))
  expect(shown(said)).toEqual([])
})

test('a survey already up keeps the row', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: ['', added('a.ts', [`k="${OPENAI}"`])] })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))
  const band = await mountBand($, false, true)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})
