import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

/**
 * The whole loop through the engine: git answered by the test (`$.process.run`
 * is an event like any other), the band drawn after a turn with changes, and
 * the files `$.fs.write` actually receives once a key is pressed.
 */

const ROOT = '/repo'

const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const NEW_FILE_DIFF = [
  'diff --git src/feature.ts src/feature.ts',
  '--- /dev/null',
  '+++ src/feature.ts',
  '@@ -0,0 +1,1 @@',
  '+export const x = 1',
  '',
].join('\n')

type Repo = {
  /** undefined: not a repository at all. */
  root?: string
  diffHead?: string
  untracked?: string[]
  /** This untracked file's own `--no-index` diff, by path. */
  untrackedDiffs?: Record<string, string>
  subjects?: string[]
}

/** Every argv the plugin handed `$.process.run`, and every transcript line it logged. */
type Seen = { runs: string[][]; logged: string[] }

/** Nothing sits beneath the plugin in a test, so the test stands in for git and the filesystem. */
const engineBottom = (on: On, repo: Repo, fs: Record<string, string> = {}, seen: Seen = { runs: [], logged: [] }) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('ui.log', ($, e) => {
    seen.logged.push(e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    seen.runs.push([...e.argv])
    const argv = e.argv.join(' ')
    if (argv.includes('--show-toplevel')) return repo.root === undefined ? ran('', 128) : ran(`${repo.root}\n`)
    if (argv.includes('diff HEAD')) return ran(repo.diffHead ?? '')
    if (argv.includes('ls-files')) return ran((repo.untracked ?? []).join('\n'))
    if (argv.includes('log -20')) return ran((repo.subjects ?? []).join('\n'))
    for (const [path, text] of Object.entries(repo.untrackedDiffs ?? {})) {
      if (argv.includes(`--no-index -- /dev/null ${path}`)) return ran(text, 1)
    }

    return ran('')
  })
  on('fs.exists', ($, e) => ({ value: Object.prototype.hasOwnProperty.call(fs, e.path) }))
  on('fs.read', ($, e) => ({ value: fs[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    fs[e.path] = e.text

    return { value: undefined }
  })

  return fs
}

const BAND = { component: 'AbovePrompt', requestId: 'above-prompt', viewport: { columns: 140, rows: 30 } } as const

const bandProps = (hasSurvey = false) =>
  ({ hasSurvey, isWorking: false, maxRows: 6, bodyColumns: 135, scroll: { offset: 0, bodyRows: 6 }, view: {} }) as const

const mountBand = ($: Engine, hasSurvey = false) =>
  $.ui.mount({ plugin: 'wait-ship', surface: 'terminal', ...BAND, props: bandProps(hasSurvey) })

const landTurn = async ($: Engine, turnId: string) => {
  await $.turn.start({ text: 'add a feature', turnId })
  await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
}

test('no changes at all: the band stays completely silent', async ($, on) => {
  engineBottom(on, { root: ROOT, diffHead: '', untracked: [] })
  await landTurn($, 'turn-1')

  const band = await mountBand($)
  expect(await band.find({ text: /ship/ })).toBeUndefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test('outside a repository: the band stays completely silent, even with files on disk', async ($, on) => {
  engineBottom(on, { root: undefined })
  await landTurn($, 'turn-2')

  const band = await mountBand($)
  expect(await band.find({ text: /ship/ })).toBeUndefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test('a turn with changes offers a kit, and accepting all writes every drafted artifact', async ($, on) => {
  const seen: Seen = { runs: [], logged: [] }
  const fs = engineBottom(
    on,
    { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [], subjects: ['feat: a', 'fix: b', 'chore: c'] },
    { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n\n### Added\n- An old entry.\n' },
    seen,
  )
  await landTurn($, 'turn-3')

  const offering = await mountBand($)
  expect(await offering.find({ text: /Drafts ready/ })).toBeDefined()
  expect(await offering.findAll({ type: 'Button' })).toHaveLength(3) // all, more, skip

  await offering.press({ key: 'all' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toContain('src/feature.ts')
  expect(fs[`${ROOT}/.waitroom/ship/PR_BODY.md`]).toContain('## Summary')
  expect(fs[`${ROOT}/.waitroom/ship/CHANGELOG_ENTRY.md`]).toBeDefined()

  // The receipt is in the transcript, one line per draft with the command to
  // use it; the row itself is free again at once.
  expect(seen.logged).toEqual([
    'Draft written: .waitroom/ship/COMMIT_EDITMSG.txt — git commit -F .waitroom/ship/COMMIT_EDITMSG.txt',
    'Draft written: .waitroom/ship/PR_BODY.md — gh pr create --body-file .waitroom/ship/PR_BODY.md',
    'Draft written: .waitroom/ship/CHANGELOG_ENTRY.md — paste .waitroom/ship/CHANGELOG_ENTRY.md into CHANGELOG.md',
  ])
  const written = await mountBand($)
  expect(await written.find({ text: /ship|Drafts/ })).toBeUndefined()
  await written.unmount()
})

test('the offer shows accept-all and skip, and More puts each draft on its own key with one press', async ($, on) => {
  engineBottom(
    on,
    { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] },
    { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n' },
  )
  await landTurn($, 'turn-more')

  const offering = await mountBand($)
  const keysNow = async () => (await offering.findAll({ type: 'Button' })).map(one => one.props.hotkey)
  expect(await keysNow()).toEqual(['a', 'm', 's'])
  for (const key of ['commit', 'pr', 'changelog', 'edit']) expect(await offering.find({ key })).toBeUndefined()

  await offering.press({ key: 'more' })

  // Expanded in place: the four single-draft keys where "More" was, skip still last.
  expect(await keysNow()).toEqual(['a', 'c', 'p', 'l', 'e', 's'])
  await offering.unmount()
})

test('pressing the commit-only key writes only the commit message', async ($, on) => {
  const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
  await landTurn($, 'turn-4')

  const offering = await mountBand($)
  await offering.press({ key: 'more' })
  await offering.press({ key: 'commit' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toBeDefined()
  expect(fs[`${ROOT}/.waitroom/ship/PR_BODY.md`]).toBeUndefined()
  expect(fs[`${ROOT}/.waitroom/ship/CHANGELOG_ENTRY.md`]).toBeUndefined()
})

test('every key only writes drafts: no git commit and no gh is ever run, only reads of the repository', async ($, on) => {
  const seen: Seen = { runs: [], logged: [] }
  const repo: Repo = { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [], subjects: ['feat: a'] }
  engineBottom(on, repo, { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n' }, seen)
  for (const [turnId, keys] of [
    ['turn-r1', ['all']],
    ['turn-r2', ['more', 'commit']],
    ['turn-r3', ['more', 'pr']],
    ['turn-r4', ['more', 'changelog']],
    ['turn-r5', ['more', 'edit']],
  ] as const) {
    // Each turn changes something of its own; one that changed nothing gets no kit.
    repo.diffHead = `${NEW_FILE_DIFF}+// ${turnId}\n`
    await landTurn($, turnId)
    const offering = await mountBand($)
    for (const key of keys) await offering.press({ key })
    await offering.unmount()
  }

  expect(seen.runs.length).toBeGreaterThan(0)
  for (const argv of seen.runs) {
    expect(argv[0]).toBe('git')
    expect(['rev-parse', 'diff', 'ls-files', 'log']).toContain(argv[1])
  }
})

test('skip writes nothing and leaves the band quiet', async ($, on) => {
  const seen: Seen = { runs: [], logged: [] }
  const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] }, {}, seen)
  await landTurn($, 'turn-5')

  const offering = await mountBand($)
  await offering.press({ key: 'skip' })
  await offering.unmount()

  expect(Object.keys(fs)).toHaveLength(0)
  expect(seen.logged).toHaveLength(0)

  const after = await mountBand($)
  expect(await after.find({ text: /ship|Drafts/ })).toBeUndefined()
  await after.unmount()
})

test(
  'a configured ship directory is honored',
  { options: { shipDir: 'ship-drafts' } },
  async ($, on) => {
    const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
    await landTurn($, 'turn-6')

    const offering = await mountBand($)
    await offering.press({ key: 'all' })
    await offering.unmount()

    expect(fs[`${ROOT}/ship-drafts/COMMIT_EDITMSG.txt`]).toBeDefined()
  },
)

test(
  'includeChangelog off leaves out the changelog option even with CHANGELOG.md present',
  { options: { includeChangelog: false } },
  async ($, on) => {
    const fs = engineBottom(
      on,
      { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] },
      { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n' },
    )
    await landTurn($, 'turn-7')

    const offering = await mountBand($)
    await offering.press({ key: 'more' })
    expect(await offering.find({ key: 'changelog' })).toBeUndefined()
    await offering.press({ key: 'all' })
    await offering.unmount()

    expect(fs[`${ROOT}/.waitroom/ship/CHANGELOG_ENTRY.md`]).toBeUndefined()
  },
)

test('disabled: zero output, even with changes sitting right there', { options: { enabled: false } }, async ($, on) => {
  engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
  await landTurn($, 'turn-8')

  const band = await mountBand($)
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test('the band yields to a survey already up, same as the other mods', async ($, on) => {
  engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
  await landTurn($, 'turn-9')

  const band = await mountBand($, true)
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test('untracked new files are picked up too, not only tracked changes', async ($, on) => {
  const fs = engineBottom(on, {
    root: ROOT,
    diffHead: '',
    untracked: ['src/feature.ts'],
    untrackedDiffs: { 'src/feature.ts': NEW_FILE_DIFF },
  })
  await landTurn($, 'turn-10')

  const offering = await mountBand($)
  expect(await offering.find({ text: /Drafts ready/ })).toBeDefined()
  await offering.press({ key: 'more' })
  await offering.press({ key: 'commit' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toContain('src/feature.ts')
})

const SESSION = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const

test('a turn that changed nothing gets no kit, however much was already changed before it', async ($, on) => {
  on('session.start', ($$, e) => ({ cwd: e.cwd }))
  const repo: Repo = { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] }
  engineBottom(on, repo)
  // The tree is already dirty when the session starts: those are not a turn's.
  await $.session.start(SESSION)

  await landTurn($, 'turn-q1') // a question answered, nothing written
  const quiet = await mountBand($)
  expect(await quiet.find({ text: /Drafts ready/ })).toBeUndefined()
  expect(await quiet.findAll({ type: 'Button' })).toHaveLength(0)
  await quiet.unmount()

  repo.diffHead = `${NEW_FILE_DIFF}+export const y = 2\n`
  await landTurn($, 'turn-q2') // this one changed a file
  const offering = await mountBand($)
  expect(await offering.find({ text: /Drafts ready/ })).toBeDefined()
  await offering.unmount()

  await landTurn($, 'turn-q3') // and this one nothing again
  const quietAgain = await mountBand($)
  expect(await quietAgain.find({ text: /Drafts ready/ })).toBeUndefined()
  await quietAgain.unmount()
})

test('the drafts folder ignores itself, so a draft is never read back as a change to ship', async ($, on) => {
  const repo: Repo = { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] }
  const fs = engineBottom(on, repo, { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n' })
  await landTurn($, 'turn-g1')
  const offering = await mountBand($)
  await offering.press({ key: 'all' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/.gitignore`]).toBe('*\n')

  // Even where git still lists them (an older folder with no .gitignore of
  // its own), the drafts are this mod's output, never a file the turn changed.
  repo.diffHead = `${NEW_FILE_DIFF}+export const z = 3\n`
  repo.untracked = ['.waitroom/ship/PR_BODY.md', '.waitroom/ship/COMMIT_EDITMSG.txt']
  repo.untrackedDiffs = {
    '.waitroom/ship/PR_BODY.md': 'diff --git .waitroom/ship/PR_BODY.md .waitroom/ship/PR_BODY.md\n--- /dev/null\n+++ .waitroom/ship/PR_BODY.md\n@@ -0,0 +1,1 @@\n+## Summary\n',
  }
  await landTurn($, 'turn-g2')
  const next = await mountBand($)
  await next.press({ key: 'more' })
  await next.press({ key: 'commit' })
  await next.unmount()
  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toContain('src/feature.ts')
  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).not.toContain('.waitroom')
})

test('a .gitignore already in the drafts folder is the person’s own, and is left as it was', async ($, on) => {
  const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] }, {
    [`${ROOT}/.waitroom/ship/.gitignore`]: 'COMMIT_EDITMSG.txt\n',
  })
  await landTurn($, 'turn-g3')
  const offering = await mountBand($)
  await offering.press({ key: 'all' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/.gitignore`]).toBe('COMMIT_EDITMSG.txt\n')
})

test(
  'drafts written to the repository root get no .gitignore: it would hide the whole repository',
  { options: { shipDir: '.' } },
  async ($, on) => {
    const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
    await landTurn($, 'turn-g4')
    const offering = await mountBand($)
    await offering.press({ key: 'all' })
    await offering.unmount()

    expect(Object.keys(fs).filter(path => path.endsWith('/COMMIT_EDITMSG.txt'))).toHaveLength(1)
    expect(Object.keys(fs).filter(path => path.endsWith('.gitignore'))).toHaveLength(0)
  },
)

/** The Box holding the offer's keys, read off the tree as drawn. */
const keyRowOf = (tree: unknown): { props: Record<string, unknown> } | undefined => {
  const node = tree as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const kids = Array.isArray(node?.children) ? node.children : []
  if (node?.type === 'Box' && kids.some(kid => (kid as { type?: string })?.type === 'Button')) {
    return node as { props: Record<string, unknown> }
  }
  for (const kid of kids) {
    const found = keyRowOf(kid)
    if (found) return found
  }

  return undefined
}

test('the expanded keys wrap at a narrow width with no blank rows between their lines', async ($, on) => {
  engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] }, { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n' })
  await landTurn($, 'turn-w1')
  // A 60-column terminal: the band's body is five less.
  const offering = await $.ui.mount({
    plugin: 'wait-ship',
    surface: 'terminal',
    ...BAND,
    viewport: { columns: 60, rows: 30 },
    props: { ...bandProps(), bodyColumns: 55 },
  })
  await offering.press({ key: 'more' })

  const row = keyRowOf(await offering.drawn())
  expect(row?.props.flexWrap).toBe('wrap')
  // A gap holds down as well as across: wrapped, it opened two blank rows.
  expect(row?.props.columnGap).toBe(2)
  expect(row?.props.gap).toBeUndefined()
  expect(row?.props.rowGap).toBeUndefined()
  await offering.unmount()
})

/*
 * The row above the prompt is shared with wait-breathe and
 * bet-on-your-agent. Each stand-in below loads in a tier beneath this mod
 * (`append`), so its row is what this mod's own `next(e)` finds there, under
 * the real mod's name, which is what the engine stamps on a row. An inline
 * plugin closes over nothing of this file, so each is written out whole.
 */

test(
  'a breathe nudge already in the row keeps it: the kit waits, never stacked beside it',
  {
    plugins: [
      {
        name: 'wait-breathe',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Text } = $.ui.resolve(e)

            return <Text>breathe: stand up and stretch</Text>
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
    await landTurn($, 'turn-b1')

    const band = await mountBand($)
    expect(await band.find({ text: /stand up and stretch/ })).toBeDefined()
    expect(await band.find({ text: /Drafts ready/ })).toBeUndefined()
    expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
    await band.unmount()
  },
)

test(
  'the kit comes ahead of a bet question beneath it, and the question gets the row once the kit is answered',
  {
    plugins: [
      {
        name: 'bet-on-your-agent',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box flexDirection="column">
                <Text>bet: Did it land?</Text>
                <Button key="landed" hotkey="1" plain onPress={() => undefined}>
                  Landed
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    const seen: Seen = { runs: [], logged: [] }
    engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] }, {}, seen)
    await landTurn($, 'turn-b2')

    const band = await mountBand($)
    // One mod at a time: the kit, and nothing of the bet's beside it.
    expect(await band.find({ text: /Drafts ready/ })).toBeDefined()
    expect(await band.find({ text: /Did it land\?/ })).toBeUndefined()
    expect(await band.find({ key: 'landed' })).toBeUndefined()

    await band.press({ key: 'all' })

    // Queued, not dropped: the bet's question is the row's next occupant,
    // and the receipt it would have waited behind is in the transcript.
    expect(await band.find({ text: /Did it land\?/ })).toBeDefined()
    expect(await band.find({ text: /Drafts/ })).toBeUndefined()
    expect(seen.logged.length).toBeGreaterThan(0)
    await band.unmount()
  },
)

test(
  'with nothing to offer, the row passes whatever is beneath through untouched',
  {
    plugins: [
      {
        name: 'bet-on-your-agent',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Box, Text, Button } = $.ui.resolve(e)

            return (
              <Box flexDirection="column">
                <Text>bet: Will it land first try?</Text>
                <Button key="p80" hotkey="3" plain onPress={() => undefined}>
                  80%
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on, { root: ROOT, diffHead: '', untracked: [] })
    await landTurn($, 'turn-b3')

    const band = await mountBand($)
    expect(await band.find({ text: /Will it land first try\?/ })).toBeDefined()
    expect(await band.find({ key: 'p80' })).toBeDefined()
    await band.unmount()
  },
)
