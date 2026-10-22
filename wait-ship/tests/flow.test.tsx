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

/** Nothing sits beneath the plugin in a test, so the test stands in for git and the filesystem. */
const engineBottom = (on: On, repo: Repo, fs: Record<string, string> = {}) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('process.run', ($, e) => {
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
  const fs = engineBottom(
    on,
    { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [], subjects: ['feat: a', 'fix: b', 'chore: c'] },
    { [`${ROOT}/CHANGELOG.md`]: '## Unreleased\n\n### Added\n- An old entry.\n' },
  )
  await landTurn($, 'turn-3')

  const offering = await mountBand($)
  expect(await offering.find({ text: /Drafts ready/ })).toBeDefined()
  expect(await offering.findAll({ type: 'Button' })).toHaveLength(6) // all, commit, pr, changelog, edit, skip

  await offering.press({ key: 'all' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toContain('src/feature.ts')
  expect(fs[`${ROOT}/.waitroom/ship/PR_BODY.md`]).toContain('## Summary')
  expect(fs[`${ROOT}/.waitroom/ship/CHANGELOG_ENTRY.md`]).toBeDefined()

  const written = await mountBand($)
  expect(await written.find({ text: /Drafts written/ })).toBeDefined()
  expect(await written.find({ text: /git commit -F/ })).toBeDefined()
  await written.unmount()
})

test('pressing the commit-only key writes only the commit message', async ($, on) => {
  const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
  await landTurn($, 'turn-4')

  const offering = await mountBand($)
  await offering.press({ key: 'commit' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toBeDefined()
  expect(fs[`${ROOT}/.waitroom/ship/PR_BODY.md`]).toBeUndefined()
  expect(fs[`${ROOT}/.waitroom/ship/CHANGELOG_ENTRY.md`]).toBeUndefined()
})

test('skip writes nothing and leaves the band quiet', async ($, on) => {
  const fs = engineBottom(on, { root: ROOT, diffHead: NEW_FILE_DIFF, untracked: [] })
  await landTurn($, 'turn-5')

  const offering = await mountBand($)
  await offering.press({ key: 'skip' })
  await offering.unmount()

  expect(Object.keys(fs)).toHaveLength(0)

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
  await offering.press({ key: 'commit' })
  await offering.unmount()

  expect(fs[`${ROOT}/.waitroom/ship/COMMIT_EDITMSG.txt`]).toContain('src/feature.ts')
})
