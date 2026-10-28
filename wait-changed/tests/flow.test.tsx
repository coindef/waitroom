import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The whole loop through the engine: git answered by the test, the card drawn
 * only after a turn that changed files, and the two actions — dismiss this
 * turn, or turn the card off for good.
 */

const ROOT = '/repo'

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const diff = (lines: readonly string[]) => lines.join('\n') + '\n'

const added = (path: string, body: readonly string[]) =>
  diff([`diff --git ${path} ${path}`, '--- /dev/null', `+++ ${path}`, '@@ -0,0 +1 @@', ...body])

const RETRY = diff([
  'diff --git src/retry.ts src/retry.ts',
  '--- src/retry.ts',
  '+++ src/retry.ts',
  '@@ -1,3 +1,12 @@',
  '-a',
  '-b',
  '-c',
  ...Array.from({ length: 12 }, (_, at) => `+n${at}`),
])

type Repo = {
  /** undefined: not a repository at all. */
  root?: string
  /** Each `git diff HEAD` takes the next entry; the last one repeats. */
  diffs: string[]
  untracked?: string[]
}

type Settings = { refuse?: string; set: { key: string; value: unknown }[] }

const engineBottom = (
  on: On,
  repo: Repo,
  settings: Settings = { set: [] },
  store: Record<string, unknown> = {},
) => {
  const seen: string[][] = []
  let diffAt = 0
  mock.store(on, store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('process.run', ($, e) => {
    seen.push([...e.argv])
    const argv = e.argv.join(' ')
    if (e.argv[0] !== 'git' || /\b(commit|push|pull|add|reset|checkout|merge|rebase|fetch|clone)\b/.test(argv)) {
      throw new Error(`not a read-only git read: ${argv}`)
    }
    if (argv.includes('--show-toplevel')) return repo.root === undefined ? ran('', 128) : ran(`${repo.root}\n`)
    if (argv.includes('ls-files')) return ran((repo.untracked ?? []).join('\n'))
    if (argv.includes('--no-index')) return ran('', 1)
    if (argv.includes('diff HEAD')) {
      const text = repo.diffs[Math.min(diffAt, Math.max(0, repo.diffs.length - 1))] ?? ''
      diffAt += 1

      return ran(text)
    }

    return ran('', 1)
  })
  on('config.list', () => ({
    value: [
      {
        key: 'wait-changed.enabled',
        label: 'Show a turn-end diff card',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'wait-changed', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    if (settings.refuse !== undefined) return { deny: settings.refuse }
    settings.set.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return seen
}

const BAND = { component: 'AbovePrompt', requestId: 'above-prompt', viewport: { columns: 140, rows: 40 } } as const

const bandProps = (isWorking: boolean, hasSurvey = false) =>
  ({
    hasSurvey,
    isWorking,
    maxRows: 6,
    bodyColumns: 135,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  }) as const

const mountBand = ($: Engine, isWorking: boolean, hasSurvey = false) =>
  $.ui.mount({ plugin: 'wait-changed', surface: 'terminal', ...BAND, props: bandProps(isWorking, hasSurvey) })

const finish = (turnId: string, isAborted = false) =>
  ({ turnId, answer: 'done', durationMs: 1000, isAborted, reason: isAborted ? 'abort' : 'answer' }) as const

test('a turn that changes nothing leaves no card, and a wait never shows one', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: ['', ''] })
  await $.turn.start({ text: 'look around', turnId: 'turn-clean' })

  const waiting = await mountBand($, true)
  expect(await waiting.find({ text: 'What changed this turn' })).toBeUndefined()
  expect(await waiting.findAll({ type: 'Button' })).toHaveLength(0)
  await waiting.unmount()

  await $.turn.complete(finish('turn-clean'))
  const done = await mountBand($, false)
  expect(await done.find({ text: 'What changed this turn' })).toBeUndefined()
  expect(await done.find({ text: "Can't read local changes" })).toBeUndefined()
  expect(await done.findAll({ type: 'Button' })).toHaveLength(0)
  await done.unmount()
})

test('dirt that was already there is not this turn', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: [RETRY, RETRY] })
  await $.turn.start({ text: 'no edits', turnId: 'turn-same' })
  await $.turn.complete(finish('turn-same'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  await band.unmount()
})

test('outside a repository the turn ends silent, with no weak tip', async ($, on) => {
  const seen = engineBottom(on, { root: undefined, diffs: [] })
  await $.turn.start({ text: 'anywhere', turnId: 'turn-norepo' })
  await $.turn.complete(finish('turn-norepo'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  expect(await band.find({ text: "Can't read local changes (not a git repo?) — still dismissible" })).toBeUndefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
  expect(seen).toHaveLength(2)
  expect(seen.every(argv => argv[0] === 'git' && argv.includes('--show-toplevel'))).toBe(true)
})

test('a turn that changes files shows the card, and only the two actions', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: ['', RETRY] })
  await $.turn.start({ text: 'rewrite retry', turnId: 'turn-diff' })

  // Still waiting: the card is a turn-end fact, even once the snapshot exists.
  const waiting = await mountBand($, true)
  expect(await waiting.find({ text: 'What changed this turn' })).toBeUndefined()
  await waiting.unmount()

  await $.turn.complete(finish('turn-diff'))

  // A render that still says the turn is running does not paint it either.
  const late = await mountBand($, true)
  expect(await late.find({ text: 'src/retry.ts' })).toBeUndefined()
  await late.unmount()

  const band = await mountBand($, false)
  expect(await band.find({ text: 'What changed this turn' })).toBeDefined()
  expect(await band.find({ text: 'Read-only local git — nothing uploaded' })).toBeDefined()
  expect(await band.find({ text: 'src/retry.ts' })).toBeDefined()
  expect(await band.find({ text: '+12 −3' })).toBeDefined()
  expect(await band.find({ text: 'Close' })).toBeDefined()
  expect(await band.find({ text: "Don't show again" })).toBeDefined()
  const buttons = await band.findAll({ type: 'Button' })
  expect(buttons.map(one => one.key).sort()).toEqual(['disable', 'dismiss'])
  // "nothing uploaded" is the subtitle. What must not appear is a write or a place to send the diff.
  expect(await band.find({ text: /commit|PR body|copy all|Accept all|open a PR/ })).toBeUndefined()
  await band.unmount()
})

test('Close puts this turn’s card away and the next turn can show its own', async ($, on) => {
  const repo: Repo = { root: ROOT, diffs: ['', RETRY, RETRY, `${RETRY}${added('src/next.ts', ['+export const n = 1'])}`] }
  engineBottom(on, repo)
  await $.turn.start({ text: 'rewrite retry', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))

  const first = await mountBand($, false)
  await first.press({ key: 'dismiss' })
  expect(await first.find({ text: 'What changed this turn' })).toBeUndefined()
  await first.unmount()

  const stayed = await mountBand($, false)
  expect(await stayed.find({ text: 'src/retry.ts' })).toBeUndefined()
  await stayed.unmount()

  await $.turn.start({ text: 'one more file', turnId: 'turn-2' })
  const during = await mountBand($, true)
  expect(await during.find({ text: 'What changed this turn' })).toBeUndefined()
  await during.unmount()
  await $.turn.complete(finish('turn-2'))

  const second = await mountBand($, false)
  expect(await second.find({ text: 'src/next.ts' })).toBeDefined()
  expect(await second.find({ text: 'src/retry.ts' })).toBeUndefined()
  await second.unmount()
})

test("Don't show again turns the card off for later turns", async ($, on) => {
  const settings: Settings = { set: [] }
  engineBottom(on, { root: ROOT, diffs: ['', RETRY, RETRY, RETRY] }, settings)
  await $.turn.start({ text: 'rewrite retry', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))

  const band = await mountBand($, false)
  await band.press({ key: 'disable' })
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  await band.unmount()
  expect(settings.set).toEqual([{ key: 'wait-changed.enabled', value: false }])

  await $.turn.start({ text: 'another', turnId: 'turn-2' })
  await $.turn.complete(finish('turn-2'))
  const later = await mountBand($, false)
  expect(await later.find({ text: 'What changed this turn' })).toBeUndefined()
  expect(await later.findAll({ type: 'Button' })).toHaveLength(0)
  await later.unmount()
})

test('a refused settings write still keeps the card off, and /wait-changed turns it back on', async ($, on) => {
  const settings: Settings = { refuse: 'a managed setting owns it', set: [] }
  engineBottom(on, { root: ROOT, diffs: ['', RETRY, '', RETRY] }, settings)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'rewrite retry', turnId: 'turn-1' })
  await $.turn.complete(finish('turn-1'))

  const band = await mountBand($, false)
  await band.press({ key: 'disable' })
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  await band.unmount()
  expect(settings.set).toEqual([])

  await $.turn.start({ text: 'still off', turnId: 'turn-2' })
  await $.turn.complete(finish('turn-2'))
  const hidden = await mountBand($, false)
  expect(await hidden.find({ text: 'What changed this turn' })).toBeUndefined()
  await hidden.unmount()

  settings.refuse = undefined
  const reply = await $.command.run({ command: 'wait-changed' } as never)
  expect(reply.text).toMatch(/^on · /)
  expect(reply.text).toContain('/wait-changed turns it off')
  expect(settings.set).toEqual([{ key: 'wait-changed.enabled', value: true }])

  await $.turn.start({ text: 'on again', turnId: 'turn-3' })
  await $.turn.complete(finish('turn-3'))
  const back = await mountBand($, false)
  expect(await back.find({ text: 'src/retry.ts' })).toBeDefined()
  await back.unmount()
})

test('nine files keep eight rows and name the rest in one line', async ($, on) => {
  const many = Array.from({ length: 9 }, (_, at) => added(`src/f${at}.ts`, ['+x'])).join('')
  engineBottom(on, { root: ROOT, diffs: ['', many] })
  await $.turn.start({ text: 'many', turnId: 'turn-many' })
  await $.turn.complete(finish('turn-many'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'src/f0.ts' })).toBeDefined()
  expect(await band.find({ text: 'src/f7.ts' })).toBeDefined()
  expect(await band.find({ text: 'src/f8.ts' })).toBeUndefined()
  expect(await band.find({ text: '1 more file…' })).toBeDefined()
  await band.unmount()
})

test('a subagent turn does not raise the card; the main turn’s own end does', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: ['', RETRY] })
  await $.turn.start({ text: 'main', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub', agentId: 'agent-1' } as never)
  await $.turn.complete({ ...finish('sub'), agentId: 'agent-1' } as never)

  const mid = await mountBand($, false)
  expect(await mid.find({ text: 'What changed this turn' })).toBeUndefined()
  await mid.unmount()

  await $.turn.complete(finish('main'))
  const band = await mountBand($, false)
  expect(await band.find({ text: 'src/retry.ts' })).toBeDefined()
  await band.unmount()
})

test('enabled off, or a stored disable, never reads git and never draws', { options: { enabled: false } }, async ($, on) => {
  const seen = engineBottom(on, { root: ROOT, diffs: [RETRY] })
  await $.turn.start({ text: 'quiet', turnId: 'turn-off' })
  await $.turn.complete(finish('turn-off'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  await band.unmount()
  expect(seen).toEqual([])
})

test('a stored disable keeps a default-on install silent', async ($, on) => {
  const seen = engineBottom(on, { root: ROOT, diffs: [RETRY] }, { set: [] }, { disabled: true })
  await $.turn.start({ text: 'quiet', turnId: 'turn-stored' })
  await $.turn.complete(finish('turn-stored'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  await band.unmount()
  expect(seen).toEqual([])
})

test('/wait-changed turns a running install off, and the next turn stays silent', async ($, on) => {
  const settings: Settings = { set: [] }
  engineBottom(on, { root: ROOT, diffs: ['', RETRY] }, settings)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const reply = await $.command.run({ command: 'wait-changed' } as never)
  expect(reply.text).toMatch(/^off · /)
  expect(reply.text).toContain('/wait-changed turns it back on')
  expect(reply.text).toContain('Show a turn-end diff card')
  expect(settings.set).toEqual([{ key: 'wait-changed.enabled', value: false }])

  await $.turn.start({ text: 'after', turnId: 'turn-after' })
  await $.turn.complete(finish('turn-after'))
  const band = await mountBand($, false)
  expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
  await band.unmount()
})

test('a stopped turn still summarizes the files it changed', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: ['', RETRY] })
  await $.turn.start({ text: 'rewrite retry', turnId: 'turn-abort' })
  await $.turn.complete({ turnId: 'turn-abort', answer: '', durationMs: 100, isAborted: true, reason: 'abort' })

  const band = await mountBand($, false)
  expect(await band.find({ text: 'src/retry.ts' })).toBeDefined()
  expect(await band.find({ text: '+12 −3' })).toBeDefined()
  await band.unmount()
})

test('a survey already up keeps the row, same as the other mods', async ($, on) => {
  engineBottom(on, { root: ROOT, diffs: ['', RETRY] })
  await $.turn.start({ text: 'rewrite retry', turnId: 'turn-row' })
  await $.turn.complete(finish('turn-row'))

  const survey = await mountBand($, false, true)
  expect(await survey.find({ text: 'What changed this turn' })).toBeUndefined()
  await survey.unmount()
})

test(
  'a breathe row beneath keeps the band, including once the turn has ended',
  {
    plugins: [
      {
        name: 'wait-breathe',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Text } = $.ui.resolve(e)

            return <Text>breathe: posture check</Text>
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on, { root: ROOT, diffs: ['', RETRY] })
    await $.turn.start({ text: 'rewrite retry', turnId: 'turn-share' })

    const waiting = await mountBand($, true)
    expect(await waiting.find({ text: 'What changed this turn' })).toBeUndefined()
    expect(await waiting.find({ text: /posture check/ })).toBeDefined()
    await waiting.unmount()

    await $.turn.complete(finish('turn-share'))
    const band = await mountBand($, false)
    // Breathe is ahead of this card, so a nudge that is actually drawn keeps the row.
    expect(await band.find({ text: /posture check/ })).toBeDefined()
    expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
    await band.unmount()
  },
)

test(
  'between turns the card holds the row ahead of a ship offer until Close',
  {
    plugins: [
      {
        name: 'wait-ship',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box>
                <Text>ship: Drafts ready</Text>
                <Button key="all" plain onPress={() => undefined}>
                  Accept all
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on, { root: ROOT, diffs: ['', RETRY] })
    await $.turn.start({ text: 'rewrite retry', turnId: 'turn-ship' })
    await $.turn.complete(finish('turn-ship'))

    const band = await mountBand($, false)
    expect(await band.find({ text: 'What changed this turn' })).toBeDefined()
    expect(await band.find({ text: /Drafts ready/ })).toBeUndefined()
    expect(await band.find({ key: 'all' })).toBeUndefined()

    await band.press({ key: 'dismiss' })
    expect(await band.find({ text: /Drafts ready/ })).toBeDefined()
    expect(await band.find({ text: 'What changed this turn' })).toBeUndefined()
    await band.unmount()
  },
)
