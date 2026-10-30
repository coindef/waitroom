import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

/**
 * The whole loop through the engine: the project's root and its scope file
 * answered by the test, edits raised as tool calls the test's own hook runs,
 * the count on the status line while a turn runs, the card once it ends, and
 * the two actions — dismiss this turn, or turn the warning off for good.
 */

const ROOT = '/repo'
const SCOPE_PATH = `${ROOT}/.claude/wait-scope`
const TITLE = 'Changed outside what you asked for'

type Project = {
  /** undefined: the engine cannot say where the project is. */
  root?: string
  /** The text of `.claude/wait-scope`; undefined: the project has none. */
  scopeFile?: string
  /** Edits to these paths are refused beneath the plugin. */
  denied?: readonly string[]
  /** Edits to these paths fail in the tool itself. */
  failing?: readonly string[]
}

type Settings = { refuse?: string; set: { key: string; value: unknown }[] }

const pathOf = (input: object): string => {
  const { file_path: file, notebook_path: notebook } = input as { file_path?: unknown; notebook_path?: unknown }

  return String(file ?? notebook ?? '')
}

const engineBottom = (
  on: On,
  project: Project = { root: ROOT },
  settings: Settings = { set: [] },
  store: Record<string, unknown> = {},
) => {
  /** Every status line the plugin set, `undefined` for a clear. */
  const said: (string | undefined)[] = []
  /** Every file system call the plugin made. */
  const touched: string[] = []
  const ran: string[][] = []
  const fetched: string[] = []
  mock.store(on, store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => {
    if (project.root === undefined) throw new Error('no project root here')

    return { value: project.root }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    const path = pathOf(e)
    if (project.denied?.includes(path)) return { deny: 'not here' }
    if (project.failing?.includes(path)) return { isError: true, result: 'boom', text: 'boom' }

    return { result: { ok: true } }
  })
  on('ui.status', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('fs.exists', ($, e) => {
    touched.push(`exists ${e.path}`)

    return { value: project.scopeFile !== undefined && e.path === SCOPE_PATH }
  })
  on('fs.read', ($, e) => {
    touched.push(`read ${e.path}`)
    if (project.scopeFile === undefined || e.path !== SCOPE_PATH) throw new Error(`ENOENT: ${e.path}`)

    return { value: project.scopeFile }
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    throw new Error(`wait-scope runs no command: ${e.argv.join(' ')}`)
  })
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    throw new Error(`wait-scope opens no connection: ${e.url}`)
  })
  on('config.list', () => ({
    value: [
      {
        key: 'wait-scope.enabled',
        label: 'Warn when a turn edits outside the scope',
        kind: 'boolean',
        value: true,
        provider: { plugin: 'wait-scope', tier: 'user' },
        isLocked: false,
      },
    ],
  }))
  on('config.set', ($, e) => {
    if (settings.refuse !== undefined) return { deny: settings.refuse }
    settings.set.push({ key: e.key, value: e.value })

    return { value: e.value }
  })

  return { said, touched, ran, fetched }
}

/** Only the status lines that showed something. */
const shown = (said: readonly (string | undefined)[]) => said.filter(text => text !== undefined)

const typed = (text: string, turnId?: string) =>
  ({ text, wait: false, origin: { kind: 'composer' }, ...(turnId === undefined ? {} : { turnId }) }) as const

const finish = (turnId: string, isAborted = false) =>
  ({ turnId, answer: 'done', durationMs: 1000, isAborted, reason: isAborted ? 'aborted' : 'answer' }) as const

const edit = ($: Engine, path: string, agentId?: string) =>
  $.tool.call({
    tool: 'Edit',
    file_path: path,
    old_string: 'a',
    new_string: 'b',
    ...(agentId === undefined ? {} : { agentId }),
  })

const write = ($: Engine, path: string) => $.tool.call({ tool: 'Write', file_path: path, content: 'x' })

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
  $.ui.mount({ plugin: 'wait-scope', surface: 'terminal', ...BAND, props: bandProps(isWorking, hasSurvey) })

test('an edit outside the scope file counts as it lands, and the card lists it once the turn ends', async ($, on) => {
  const { said, ran, fetched } = engineBottom(on, { root: ROOT, scopeFile: '# this task\nsrc/auth/**\n' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('fix the login redirect'))
  await $.turn.start({ text: 'fix the login redirect', turnId: 'turn-1' })

  const inside = await edit($, `${ROOT}/src/auth/login.ts`)
  // Never blocked, never rewritten: the tool's own answer comes back as it was.
  expect(inside.result).toEqual({ ok: true })
  expect(shown(said)).toEqual([])

  await write($, `${ROOT}/package.json`)
  expect(said.at(-1)).toBe('1 outside scope')
  await edit($, `${ROOT}/package.json`)
  expect(said.at(-1)).toBe('1 outside scope')
  const notebook = await $.tool.call({
    tool: 'NotebookEdit',
    notebook_path: `${ROOT}/notebooks/explore.ipynb`,
    new_source: 'x = 1',
  })
  expect(notebook.result).toEqual({ ok: true })
  expect(said.at(-1)).toBe('2 outside scope')

  // Still running: the list is a turn-end fact.
  const waiting = await mountBand($, true)
  expect(await waiting.find({ text: TITLE })).toBeUndefined()
  await waiting.unmount()

  await $.turn.complete(finish('turn-1'))
  expect(said.at(-1)).toBe('2 outside scope')

  // A render that still says the turn is running does not paint it either.
  const late = await mountBand($, true)
  expect(await late.find({ text: 'package.json' })).toBeUndefined()
  await late.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'wait-scope', surface, ...BAND, props: bandProps(false) })
    expect(await band.find({ text: TITLE })).toBeDefined()
    expect(await band.find({ text: 'Scope: .claude/wait-scope — a warning, nothing blocked or undone' })).toBeDefined()
    expect(await band.find({ text: 'package.json' })).toBeDefined()
    expect(await band.find({ text: 'notebooks/explore.ipynb' })).toBeDefined()
    expect(await band.find({ text: 'src/auth/login.ts' })).toBeUndefined()
    expect(await band.find({ text: '(guess)' })).toBeUndefined()
    const buttons = await band.findAll({ type: 'Button' })
    expect(buttons.map(one => one.key).sort()).toEqual(['disable', 'dismiss'])
    // Only a warning: no button on the card undoes, blocks or sends anything.
    for (const button of buttons) expect(button.text).not.toMatch(/revert|undo|block|commit|upload/i)
    await band.unmount()
  }
  expect(ran).toEqual([])
  expect(fetched).toEqual([])
})

test(
  'the Files in scope setting stands in where the project has no scope file',
  { options: { globs: 'src/**, docs' } },
  async ($, on) => {
    const { said, touched } = engineBottom(on)
    await $.prompt.submit(typed('write the guide'))
    await $.turn.start({ text: 'write the guide', turnId: 'turn-setting' })
    await edit($, `${ROOT}/src/a.ts`)
    await write($, `${ROOT}/docs/guide.md`)
    expect(shown(said)).toEqual([])
    await edit($, `${ROOT}/README.md`)
    expect(said.at(-1)).toBe('1 outside scope')
    await $.turn.complete(finish('turn-setting'))
    // It looked for the project's file, found none, and read nothing else.
    expect(touched).toEqual([`exists ${SCOPE_PATH}`])

    const band = await mountBand($, false)
    expect(await band.find({ text: 'Scope: the Files in scope setting — a warning, nothing blocked or undone' })).toBeDefined()
    expect(await band.find({ text: 'README.md' })).toBeDefined()
    expect(await band.find({ text: 'docs/guide.md' })).toBeUndefined()
    await band.unmount()
  },
)

test("a project's scope file wins over the setting", { options: { globs: '**' } }, async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, scopeFile: 'src/**\n' })
  await $.turn.start({ text: 'go', turnId: 'turn-file' })
  await edit($, `${ROOT}/README.md`)

  expect(said.at(-1)).toBe('1 outside scope')
})

test('with no scope, the files the prompt did not name are listed as (guess), and never counted', async ($, on) => {
  const { said } = engineBottom(on)
  const prompt = 'Fix the retry in src/client/retry.ts and say so in README.md'
  await $.prompt.submit(typed(prompt))
  await $.turn.start({ text: prompt, turnId: 'turn-guess' })
  await edit($, `${ROOT}/src/client/retry.ts`)
  await edit($, `${ROOT}/README.md`)
  await write($, `${ROOT}/src/client/retry.test.ts`)
  await edit($, `${ROOT}/package.json`)
  expect(shown(said)).toEqual([])
  await $.turn.complete(finish('turn-guess'))
  expect(shown(said)).toEqual([])

  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeDefined()
  expect(
    await band.find({ text: 'No scope set — a guess from the paths your prompt named, nothing blocked or undone' }),
  ).toBeDefined()
  expect(await band.find({ text: 'src/client/retry.test.ts' })).toBeDefined()
  expect(await band.find({ text: 'package.json' })).toBeDefined()
  expect(await band.findAll({ type: 'Text', text: '(guess)' })).toHaveLength(2)
  expect(await band.find({ text: /^src\/client\/retry\.ts$/ })).toBeUndefined()
  expect(await band.find({ text: /^README\.md$/ })).toBeUndefined()
  await band.unmount()
})

test('no scope and no path in the prompt: edits show nothing at all', async ($, on) => {
  const { said, touched } = engineBottom(on)
  await $.prompt.submit(typed('tidy things up a bit'))
  await $.turn.start({ text: 'tidy things up a bit', turnId: 'turn-none' })
  await edit($, `${ROOT}/src/a.ts`)
  await write($, `${ROOT}/package.json`)
  await $.turn.complete(finish('turn-none'))

  expect(shown(said)).toEqual([])
  expect(touched).toEqual([`exists ${SCOPE_PATH}`])
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  expect(await band.findAll({ type: 'Button' })).toHaveLength(0)
  await band.unmount()
})

test("the person's globs are authoritative: a path the prompt named outside them is still outside", async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
  await $.prompt.submit(typed('bump the version in package.json'))
  await $.turn.start({ text: 'bump the version in package.json', turnId: 'turn-auth' })
  await edit($, `${ROOT}/package.json`)
  expect(said.at(-1)).toBe('1 outside scope')
  await $.turn.complete(finish('turn-auth'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'package.json' })).toBeDefined()
  expect(await band.find({ text: '(guess)' })).toBeUndefined()
  await band.unmount()
})

test('a refused or failed edit is not an edit, and its answer passes through untouched', async ($, on) => {
  const { said } = engineBottom(on, {
    root: ROOT,
    scopeFile: 'src/**',
    denied: [`${ROOT}/secret.txt`],
    failing: [`${ROOT}/broken.ts`],
  })
  await $.turn.start({ text: 'try', turnId: 'turn-refused' })

  const refused = await write($, `${ROOT}/secret.txt`)
  expect(refused.deny).toBe('not here')
  const failed = await edit($, `${ROOT}/broken.ts`)
  expect(failed.isError).toBe(true)
  expect(shown(said)).toEqual([])

  await $.turn.complete(finish('turn-refused'))
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})

test('MultiEdit is an edit too', async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
  await $.turn.start({ text: 'many', turnId: 'turn-multi' })
  await $.tool.call({
    tool: 'MultiEdit',
    file_path: `${ROOT}/README.md`,
    edits: [{ old_string: 'a', new_string: 'b' }],
  } as never)

  expect(said.at(-1)).toBe('1 outside scope')
})

test("a subagent's edits count toward the main turn, and its own start and end change nothing", async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
  await $.turn.start({ text: 'main', turnId: 'main' })
  await $.turn.start({ text: 'sub', turnId: 'sub', agentId: 'agent-1' })
  await edit($, `${ROOT}/README.md`, 'agent-1')
  expect(said.at(-1)).toBe('1 outside scope')
  await $.turn.complete({ ...finish('sub'), agentId: 'agent-1' })

  const mid = await mountBand($, false)
  expect(await mid.find({ text: TITLE })).toBeUndefined()
  await mid.unmount()
  expect(said.at(-1)).toBe('1 outside scope')

  await $.turn.complete(finish('main'))
  const band = await mountBand($, false)
  expect(await band.find({ text: 'README.md' })).toBeDefined()
  await band.unmount()
})

test('a prompt typed while the turn runs adds the paths it names to that turn', async ($, on) => {
  engineBottom(on)
  await $.prompt.submit(typed('fix src/a.ts'))
  await $.turn.start({ text: 'fix src/a.ts', turnId: 'turn-more' })
  await edit($, `${ROOT}/src/a.ts`)
  await edit($, `${ROOT}/package.json`)
  await edit($, `${ROOT}/CHANGELOG.md`)
  await $.prompt.submit(typed('and bump package.json too', 'turn-more'))
  await $.turn.complete(finish('turn-more'))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'CHANGELOG.md' })).toBeDefined()
  expect(await band.find({ text: 'package.json' })).toBeUndefined()
  await band.unmount()
})

test('a slash command and a task notification name no paths', async ($, on) => {
  engineBottom(on)
  await $.prompt.submit({ ...typed('/review src/a.ts'), command: { name: 'review', args: 'src/a.ts' } })
  await $.turn.start({ text: 'review src/a.ts', turnId: 'turn-command' })
  await edit($, `${ROOT}/package.json`)
  await $.turn.complete(finish('turn-command'))
  const afterCommand = await mountBand($, false)
  expect(await afterCommand.find({ text: TITLE })).toBeUndefined()
  await afterCommand.unmount()

  await $.prompt.submit(typed('fix src/a.ts'))
  await $.prompt.submit({ text: 'Task done: see src/b.ts', wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: 'Task done: see src/b.ts', turnId: 'turn-task' })
  await edit($, `${ROOT}/package.json`)
  await $.turn.complete(finish('turn-task'))
  const afterTask = await mountBand($, false)
  expect(await afterTask.find({ text: TITLE })).toBeUndefined()
  await afterTask.unmount()
})

test('Close puts the card and the count away; a later edit outside brings them back; the next turn starts clean', async ($, on) => {
  const { said } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-1'))

  const first = await mountBand($, false)
  await first.press({ key: 'dismiss' })
  expect(await first.find({ text: TITLE })).toBeUndefined()
  await first.unmount()
  expect(said.at(-1)).toBeUndefined()

  const stayed = await mountBand($, false)
  expect(await stayed.find({ text: 'README.md' })).toBeUndefined()
  await stayed.unmount()

  // A background agent of that turn writes once more, outside the scope.
  await write($, `${ROOT}/LICENSE`)
  expect(said.at(-1)).toBe('2 outside scope')
  const back = await mountBand($, false)
  expect(await back.find({ text: 'LICENSE' })).toBeDefined()
  await back.unmount()

  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  expect(said.at(-1)).toBeUndefined()
  const during = await mountBand($, true)
  expect(await during.find({ text: TITLE })).toBeUndefined()
  await during.unmount()
  await edit($, `${ROOT}/src/ok.ts`)
  await $.turn.complete(finish('turn-2'))
  const second = await mountBand($, false)
  expect(await second.find({ text: TITLE })).toBeUndefined()
  await second.unmount()
  expect(said.at(-1)).toBeUndefined()
})

test("Don't show again turns it off: later turns read no file, set no count and draw nothing", async ($, on) => {
  const settings: Settings = { set: [] }
  const { said, touched } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' }, settings)
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-1'))

  const band = await mountBand($, false)
  await band.press({ key: 'disable' })
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
  expect(settings.set).toEqual([{ key: 'wait-scope.enabled', value: false }])
  expect(said.at(-1)).toBeUndefined()

  const files = touched.length
  const lines = said.length
  await $.turn.start({ text: 'two', turnId: 'turn-2' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-2'))
  expect(touched).toHaveLength(files)
  expect(shown(said.slice(lines))).toEqual([])
  const later = await mountBand($, false)
  expect(await later.find({ text: TITLE })).toBeUndefined()
  expect(await later.findAll({ type: 'Button' })).toHaveLength(0)
  await later.unmount()
})

test('a refused settings write still keeps it off, and /wait-scope turns it back on', async ($, on) => {
  const settings: Settings = { refuse: 'a managed setting owns it', set: [] }
  const { said } = engineBottom(on, { root: ROOT, scopeFile: 'src/**\ndocs/**\n' }, settings)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'one', turnId: 'turn-1' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-1'))

  const band = await mountBand($, false)
  await band.press({ key: 'disable' })
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
  expect(settings.set).toEqual([])

  await $.turn.start({ text: 'still off', turnId: 'turn-2' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-2'))
  expect(said.at(-1)).toBeUndefined()
  const hidden = await mountBand($, false)
  expect(await hidden.find({ text: TITLE })).toBeUndefined()
  await hidden.unmount()

  settings.refuse = undefined
  const reply = await $.command.run({ command: 'wait-scope' } as never)
  expect(reply.text).toBe('on · 2 globs from .claude/wait-scope · /wait-scope turns it off')
  expect(settings.set).toEqual([{ key: 'wait-scope.enabled', value: true }])

  await $.turn.start({ text: 'on again', turnId: 'turn-3' })
  await edit($, `${ROOT}/README.md`)
  expect(said.at(-1)).toBe('1 outside scope')
  await $.turn.complete(finish('turn-3'))
  const back = await mountBand($, false)
  expect(await back.find({ text: 'README.md' })).toBeDefined()
  await back.unmount()
})

test(
  '/wait-scope turns a running install off, then back on naming the scope it found',
  { options: { globs: 'src/**' } },
  async ($, on) => {
    const settings: Settings = { set: [] }
    const { said } = engineBottom(on, { root: ROOT }, settings)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

    const off = await $.command.run({ command: 'wait-scope' } as never)
    expect(off.text).toBe(
      'off · /wait-scope turns it back on · /plugin → wait-scope → Warn when a turn edits outside the scope',
    )
    expect(settings.set).toEqual([{ key: 'wait-scope.enabled', value: false }])

    await $.turn.start({ text: 'after', turnId: 'turn-after' })
    await edit($, `${ROOT}/README.md`)
    await $.turn.complete(finish('turn-after'))
    expect(shown(said)).toEqual([])

    const back = await $.command.run({ command: 'wait-scope' } as never)
    expect(back.text).toBe('on · 1 glob from the Files in scope setting · /wait-scope turns it off')
    expect(settings.set.map(row => row.value)).toEqual([false, true])
  },
)

test('/wait-scope with no scope anywhere says the prompt is only a guess', async ($, on) => {
  engineBottom(on, { root: ROOT }, { set: [] }, { disabled: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const reply = await $.command.run({ command: 'wait-scope' } as never)

  expect(reply.text).toBe('on · no scope set, so the paths your prompt names are a guess · /wait-scope turns it off')
})

test(
  'enabled off never reads the project, never sets a count and never draws',
  { options: { enabled: false } },
  async ($, on) => {
    const { said, touched } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
    await $.prompt.submit(typed('fix src/a.ts'))
    await $.turn.start({ text: 'fix src/a.ts', turnId: 'turn-off' })
    await edit($, `${ROOT}/README.md`)
    await $.turn.complete(finish('turn-off'))

    expect(touched).toEqual([])
    expect(shown(said)).toEqual([])
    const band = await mountBand($, false)
    expect(await band.find({ text: TITLE })).toBeUndefined()
    await band.unmount()
  },
)

test('a stored disable keeps a default-on install silent', async ($, on) => {
  const { said, touched } = engineBottom(on, { root: ROOT, scopeFile: 'src/**' }, { set: [] }, { disabled: true })
  await $.turn.start({ text: 'quiet', turnId: 'turn-stored' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-stored'))

  expect(touched).toEqual([])
  expect(shown(said)).toEqual([])
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})

test('without a project root to read against, the turn stays silent', async ($, on) => {
  const { said } = engineBottom(on, { scopeFile: 'src/**' })
  await $.turn.start({ text: 'anywhere', turnId: 'turn-rootless' })
  await edit($, '/somewhere/README.md')
  await $.turn.complete(finish('turn-rootless'))

  expect(shown(said)).toEqual([])
  const band = await mountBand($, false)
  expect(await band.find({ text: TITLE })).toBeUndefined()
  await band.unmount()
})

test('a stopped turn still lists what it edited outside the scope', async ($, on) => {
  engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
  await $.turn.start({ text: 'go', turnId: 'turn-abort' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-abort', true))

  const band = await mountBand($, false)
  expect(await band.find({ text: 'README.md' })).toBeDefined()
  await band.unmount()
})

test('a survey already up keeps the row, same as the other mods', async ($, on) => {
  engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
  await $.turn.start({ text: 'go', turnId: 'turn-survey' })
  await edit($, `${ROOT}/README.md`)
  await $.turn.complete(finish('turn-survey'))

  const survey = await mountBand($, false, true)
  expect(await survey.find({ text: TITLE })).toBeUndefined()
  await survey.unmount()
})

test(
  'a wait-changed card beneath keeps the row, and this card shows once that one is closed',
  {
    plugins: [
      {
        name: 'wait-changed',
        tier: 'append',
        register(on) {
          // The stand-in's own state: an inline plugin runs in an environment of its own.
          let isUp = true
          on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
            if (!isUp) return next(e)
            const { Box, Text, Button } = $.ui.resolve(e)
            const close = () => {
              isUp = false
              $.ui.invalidate('ui.render')
            }

            return (
              <Box>
                <Text>What changed this turn</Text>
                <Button key="close" plain onPress={close}>
                  Close
                </Button>
              </Box>
            )
          })
        },
      },
    ],
  },
  async ($, on) => {
    engineBottom(on, { root: ROOT, scopeFile: 'src/**' })
    await $.turn.start({ text: 'go', turnId: 'turn-share' })
    await edit($, `${ROOT}/README.md`)
    await $.turn.complete(finish('turn-share'))

    const band = await mountBand($, false)
    expect(await band.find({ text: 'What changed this turn' })).toBeDefined()
    expect(await band.find({ text: TITLE })).toBeUndefined()
    await $.ui.press({ plugin: 'wait-changed', key: 'close' })
    await band.unmount()

    const after = await mountBand($, false)
    expect(await after.find({ text: TITLE })).toBeDefined()
    expect(await after.find({ text: 'What changed this turn' })).toBeUndefined()
    await after.unmount()
  },
)
