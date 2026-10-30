import { expect, test } from 'claude-code/testing'

import {
  BAND_PRECEDENCE,
  cardFor,
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  editedPathOf,
  editLanded,
  enabledRowKey,
  globCovers,
  GUESS,
  hintsFrom,
  inScope,
  isPersonsPrompt,
  MAX_ROWS,
  mentionsIn,
  modeOf,
  outsideOf,
  overflowLine,
  parseGlobs,
  projectPath,
  resolveScope,
  SCOPE_FILE,
  startTurn,
  statusLine,
  subtitleOf,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  withEdit,
  withHints,
  yieldsBand,
} from '../hooks/scope'
import type { Scope, ScopeTurn } from '../types'

const ROOT = '/repo'

const scoped = (...globs: string[]): Scope => ({ source: 'file', globs })
const fromSetting = (...globs: string[]): Scope => ({ source: 'setting', globs })
const noScope: Scope = { source: 'none' }

/** A turn started under `scope` from `prompt`, with `edits` (absolute paths) landed in order. */
const turnOf = (scope: Scope, prompt: string, edits: readonly string[], isDone = true): ScopeTurn => {
  const started = startTurn({ turnId: 'turn-1', root: ROOT, scope, hints: hintsFrom(prompt, ROOT) })
  const edited = edits.reduce((turn, path) => withEdit(turn, path), started)

  return { ...edited, isDone }
}

const at = (path: string) => `${ROOT}/${path}`

test('the card copy is the spec copy, and nothing longer', () => {
  expect(TITLE).toBe('Changed outside what you asked for')
  expect(subtitleOf(scoped('src/**'))).toBe('Scope: .claude/wait-scope — a warning, nothing blocked or undone')
  expect(subtitleOf(fromSetting('src/**'))).toBe('Scope: the Files in scope setting — a warning, nothing blocked or undone')
  expect(subtitleOf(noScope)).toBe('No scope set — a guess from the paths your prompt named, nothing blocked or undone')
  expect(GUESS).toBe('(guess)')
  expect(DISMISS_LABEL).toBe('Close')
  expect(DISABLE_LABEL).toBe("Don't show again")
  expect(SCOPE_FILE).toBe('.claude/wait-scope')
  expect(MAX_ROWS).toBe(8)
  expect(overflowLine(1)).toBe('1 more file…')
  expect(overflowLine(3)).toBe('3 more files…')
})

// ---------------------------------------------------------------------------
// (1) A scope of the person's own globs: match and violation
// ---------------------------------------------------------------------------

test('a glob keeps * inside one folder, ** across folders, and ? to one character', () => {
  expect(globCovers('src/*.ts', 'src/a.ts')).toBe(true)
  expect(globCovers('src/*.ts', 'src/auth/a.ts')).toBe(false)
  expect(globCovers('src/**/*.ts', 'src/auth/deep/a.ts')).toBe(true)
  expect(globCovers('src/**/*.ts', 'src/a.ts')).toBe(true)
  expect(globCovers('*.md', 'docs/a.md')).toBe(false)
  expect(globCovers('**/*.md', 'docs/a.md')).toBe(true)
  expect(globCovers('**/*.md', 'a.md')).toBe(true)
  expect(globCovers('a?.ts', 'a1.ts')).toBe(true)
  expect(globCovers('a?.ts', 'a12.ts')).toBe(false)
  // A dot is a dot, not any character.
  expect(globCovers('*.map', 'axmap')).toBe(false)
})

test('a glob that names a folder covers everything inside it, and only that folder', () => {
  expect(globCovers('src/auth', 'src/auth/login.ts')).toBe(true)
  expect(globCovers('src/auth', 'src/auth/deep/session.ts')).toBe(true)
  expect(globCovers('src/auth', 'src/auth')).toBe(true)
  expect(globCovers('src/auth', 'src/authz/login.ts')).toBe(false)
  expect(globCovers('src/*', 'src/auth/login.ts')).toBe(true)
  expect(globCovers('docs', 'docsite/index.md')).toBe(false)
})

test('a scope reads one glob per line or comma, drops blanks and # comments, and anchors ./ and / at the root', () => {
  expect(parseGlobs('# what this task touches\nsrc/auth/**\n\n  docs/guide.md  \n./tests/auth/**\n/README.md\n')).toEqual([
    'src/auth/**',
    'docs/guide.md',
    'tests/auth/**',
    'README.md',
  ])
  expect(parseGlobs('src/**, docs')).toEqual(['src/**', 'docs'])
  expect(parseGlobs('src/auth/')).toEqual(['src/auth'])
  expect(parseGlobs('# a, b\r\nlib/**\r\n')).toEqual(['lib/**'])
  expect(parseGlobs('src\\auth\\**')).toEqual(['src/auth/**'])
  expect(parseGlobs('')).toEqual([])
  expect(parseGlobs('  \n# only a comment\n')).toEqual([])
})

test('an edited path is read against the project root, and stays absolute outside it', () => {
  expect(projectPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
  expect(projectPath('/repo/', '/repo/src/../lib/./b.ts')).toBe('lib/b.ts')
  expect(projectPath('/repo', 'src/a.ts')).toBe('src/a.ts')
  expect(projectPath('/repo', '/repository/x.ts')).toBe('/repository/x.ts')
  expect(projectPath('/repo', '/repo/../tmp/notes.md')).toBe('/tmp/notes.md')
  expect(projectPath('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts')
})

test('inside the scope is inside the root and under a glob: ** covers the project, never the machine', () => {
  expect(inScope('src/a.ts', ['src/**'])).toBe(true)
  expect(inScope('README.md', ['src/**'])).toBe(false)
  expect(inScope('any/folder/at/all.ts', ['**'])).toBe(true)
  expect(inScope('/tmp/scratch.ts', ['**'])).toBe(false)
  expect(inScope('src/a.ts', [])).toBe(false)
})

test('the project file wins, the setting stands in without one, and neither is no scope', () => {
  expect(resolveScope('src/**\n', 'docs/**')).toEqual({ source: 'file', globs: ['src/**'] })
  expect(resolveScope(undefined, 'docs/**, README.md')).toEqual({ source: 'setting', globs: ['docs/**', 'README.md'] })
  expect(resolveScope('# nothing yet\n', 'docs/**')).toEqual({ source: 'setting', globs: ['docs/**'] })
  expect(resolveScope(undefined, '')).toEqual({ source: 'none' })
  expect(resolveScope(undefined, undefined)).toEqual({ source: 'none' })
  expect(resolveScope('', 42)).toEqual({ source: 'none' })
})

test('with a scope, each file edited outside it counts once, in the order it was first edited', () => {
  const turn = turnOf(scoped('src/auth/**'), '', [
    at('src/auth/login.ts'),
    at('package.json'),
    at('src/auth/session.ts'),
    at('package.json'),
    at('docs/a.md'),
  ])

  expect(modeOf(turn)).toBe('scope')
  expect(turn.edited).toEqual(['src/auth/login.ts', 'package.json', 'src/auth/session.ts', 'docs/a.md'])
  expect(outsideOf(turn)).toEqual(['package.json', 'docs/a.md'])
  expect(statusLine(turn)).toBe('2 outside scope')
  expect(statusLine(turnOf(scoped('src/auth/**'), '', [at('package.json')]))).toBe('1 outside scope')
  expect(statusLine(turnOf(scoped('src/auth/**'), '', [at('src/auth/login.ts')]))).toBeUndefined()
  expect(statusLine(turnOf(scoped('src/auth/**'), '', []))).toBeUndefined()
})

test('an edit outside the project root is outside any scope', () => {
  const turn = turnOf(scoped('**'), '', [at('src/a.ts'), '/tmp/scratch.ts'])

  expect(outsideOf(turn)).toEqual(['/tmp/scratch.ts'])
  expect(statusLine(turn)).toBe('1 outside scope')
})

test('the card lists the files outside the scope once the turn has ended, eight at most', () => {
  const edits = [at('src/ok.ts'), at('package.json'), at('docs/a.md')]

  expect(cardFor(turnOf(scoped('src/**'), '', edits, false))).toBeNull()
  expect(cardFor(turnOf(scoped('src/**'), '', edits))).toEqual({
    subtitle: 'Scope: .claude/wait-scope — a warning, nothing blocked or undone',
    rows: [
      { path: 'package.json', hint: '' },
      { path: 'docs/a.md', hint: '' },
    ],
    overflow: 0,
  })
  expect(cardFor(turnOf(fromSetting('src/**'), '', edits))?.subtitle).toBe(
    'Scope: the Files in scope setting — a warning, nothing blocked or undone',
  )

  const many = (count: number) => Array.from({ length: count }, (_, index) => at(`out/f${index}.ts`))
  const nine = cardFor(turnOf(scoped('src/**'), '', many(9)))
  const eight = cardFor(turnOf(scoped('src/**'), '', many(8)))
  expect(nine?.rows).toHaveLength(8)
  expect(nine?.rows.map(row => row.path)).not.toContain('out/f8.ts')
  expect(nine?.overflow).toBe(1)
  expect(eight?.rows).toHaveLength(8)
  expect(eight?.overflow).toBe(0)
  expect(cardFor(turnOf(scoped('src/**'), '', [at('src/ok.ts')]))).toBeNull()
})

test('Close puts the card and the count away, and a new file outside brings them back', () => {
  const closed = { ...turnOf(scoped('src/**'), '', [at('package.json'), at('README.md')]), isDismissed: true }

  expect(cardFor(closed)).toBeNull()
  expect(statusLine(closed)).toBeUndefined()

  const inside = withEdit(closed, at('src/late.ts'))
  expect(inside.isDismissed).toBe(true)
  expect(withEdit(closed, at('package.json')).isDismissed).toBe(true)

  const outside = withEdit(closed, at('LICENSE'))
  expect(outside.isDismissed).toBe(false)
  expect(statusLine(outside)).toBe('3 outside scope')
  expect(cardFor(outside)?.rows.map(row => row.path)).toEqual(['package.json', 'README.md', 'LICENSE'])
})

// ---------------------------------------------------------------------------
// (2) No glob: the paths the prompt named, only ever a hint
// ---------------------------------------------------------------------------

test('a prompt names files, folders and globs, in the order written', () => {
  expect(
    mentionsIn(
      'Fix the retry in src/client/retry.ts and @src/api/, update README.md, `lib/util` and *.snap; see docs/guide.md:12.',
    ),
  ).toEqual(['src/client/retry.ts', 'src/api/', 'README.md', 'lib/util', '*.snap', 'docs/guide.md'])
  expect(mentionsIn('touch .gitignore, ../shared/util.ts, /etc/hosts and packages/app/src')).toEqual([
    '.gitignore',
    '../shared/util.ts',
    '/etc/hosts',
    'packages/app/src',
  ])
  expect(mentionsIn('see [the guide](docs/guide.md) and "src\\auth\\login.ts" and src/a.ts#L10-L12')).toEqual([
    'docs/guide.md',
    'src/auth/login.ts',
    'src/a.ts',
  ])
})

test('prose, versions, links, commands and code are not paths', () => {
  expect(
    mentionsIn(
      'e.g. i.e. etc. a.m. v2.1.291 3.5 and/or on/off TCP/IP 1/2 https://example.com/a.ts www.example.com ' +
        'github.com/org/repo user@example.com /clear --no-prefix Next.js console.log(x) res.json() JSON.parse ' +
        '* **bold** @types/node .NET',
    ),
  ).toEqual([])
})

test('a named file covers itself, a named folder what is under it, and a bare name any folder that holds it', () => {
  const turn = turnOf(noScope, 'edit src/client/retry.ts, the docs/ folder, and README.md', [
    at('src/client/retry.ts'),
    at('docs/a/b.md'),
    at('packages/x/README.md'),
    at('src/client/retry.test.ts'),
    at('package.json'),
  ])

  expect(modeOf(turn)).toBe('guess')
  expect(turn.hints).toEqual([
    { kind: 'path', value: 'src/client/retry.ts' },
    { kind: 'path', value: 'docs' },
    { kind: 'name', value: 'README.md' },
  ])
  expect(outsideOf(turn)).toEqual(['src/client/retry.test.ts', 'package.json'])
})

test('a glob in the prompt is a glob, and a bare one reaches into every folder', () => {
  expect(hintsFrom('every *.md file', ROOT)).toEqual([{ kind: 'glob', value: '**/*.md' }])
  expect(hintsFrom('only src/**/*.test.ts', ROOT)).toEqual([{ kind: 'glob', value: 'src/**/*.test.ts' }])
  expect(hintsFrom('see /repo/src/a.ts and ./lib/b.ts', ROOT)).toEqual([
    { kind: 'path', value: 'src/a.ts' },
    { kind: 'path', value: 'lib/b.ts' },
  ])

  const turn = turnOf(noScope, 'every *.md file', [at('docs/a.md'), at('a.md'), at('src/a.ts')])
  expect(outsideOf(turn)).toEqual(['src/a.ts'])
})

test('the guesses are listed as (guess) once the turn ends, and never reach the status line', () => {
  const turn = turnOf(noScope, 'Fix the retry in src/client/retry.ts', [
    at('src/client/retry.ts'),
    at('src/client/retry.test.ts'),
    at('package.json'),
  ])

  expect(statusLine(turn)).toBeUndefined()
  expect(cardFor(turn)).toEqual({
    subtitle: 'No scope set — a guess from the paths your prompt named, nothing blocked or undone',
    rows: [
      { path: 'src/client/retry.test.ts', hint: '(guess)' },
      { path: 'package.json', hint: '(guess)' },
    ],
    overflow: 0,
  })
})

test("the person's globs are authoritative: a path the prompt named outside them is still outside", () => {
  const turn = turnOf(scoped('src/**'), 'bump the version in package.json', [at('package.json'), at('src/a.ts')])

  expect(modeOf(turn)).toBe('scope')
  expect(outsideOf(turn)).toEqual(['package.json'])
  expect(statusLine(turn)).toBe('1 outside scope')
  expect(cardFor(turn)?.rows).toEqual([{ path: 'package.json', hint: '' }])
})

test('paths typed while the turn runs join its hints, once each', () => {
  const turn = turnOf(noScope, 'fix src/a.ts', [at('src/a.ts'), at('package.json'), at('CHANGELOG.md')])
  expect(outsideOf(turn)).toEqual(['package.json', 'CHANGELOG.md'])

  const told = withHints(turn, hintsFrom('and bump package.json, then src/a.ts again', ROOT))
  expect(told.hints).toEqual([
    { kind: 'path', value: 'src/a.ts' },
    { kind: 'name', value: 'package.json' },
  ])
  expect(outsideOf(told)).toEqual(['CHANGELOG.md'])
})

test('only what the person typed can name a path', () => {
  const typed = { text: 'fix src/a.ts', wait: false } as const

  expect(isPersonsPrompt({ ...typed, origin: { kind: 'composer' } })).toBe(true)
  expect(isPersonsPrompt({ ...typed, origin: { kind: 'bridge' } })).toBe(true)
  expect(isPersonsPrompt({ ...typed, origin: { kind: 'task-notification' } })).toBe(false)
  expect(isPersonsPrompt({ ...typed, origin: { kind: 'peer' } })).toBe(false)
  expect(isPersonsPrompt({ ...typed, origin: { kind: 'unclassified' } })).toBe(false)
  expect(isPersonsPrompt({ ...typed, origin: { kind: 'composer' }, isMeta: true })).toBe(false)
  expect(
    isPersonsPrompt({ ...typed, origin: { kind: 'composer' }, command: { name: 'review', args: 'src/a.ts' } }),
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// (3) No scope at all
// ---------------------------------------------------------------------------

test('no scope and no path named: nothing to count, and nothing to list', () => {
  const turn = turnOf(noScope, 'tidy things up a bit', [at('src/a.ts'), at('package.json')])

  expect(modeOf(turn)).toBe('none')
  expect(turn.hints).toEqual([])
  expect(outsideOf(turn)).toEqual([])
  expect(statusLine(turn)).toBeUndefined()
  expect(cardFor(turn)).toBeNull()
})

test('an empty or comment-only scope file and an empty setting are no scope, and stay silent', () => {
  const scope = resolveScope('\n# soon\n', '  ')
  const turn = turnOf(scope, '', [at('src/a.ts'), '/tmp/elsewhere.ts'])

  expect(scope).toEqual({ source: 'none' })
  expect(modeOf(turn)).toBe('none')
  expect(statusLine(turn)).toBeUndefined()
  expect(cardFor(turn)).toBeNull()
})

// ---------------------------------------------------------------------------
// Edits, the command and the row
// ---------------------------------------------------------------------------

test('only a landed Edit, Write, MultiEdit or NotebookEdit is an edit', () => {
  expect(editedPathOf('Edit', { file_path: at('a.ts') })).toBe(at('a.ts'))
  expect(editedPathOf('Write', { file_path: at('b.ts') })).toBe(at('b.ts'))
  expect(editedPathOf('MultiEdit', { file_path: at('c.ts') })).toBe(at('c.ts'))
  expect(editedPathOf('NotebookEdit', { notebook_path: at('d.ipynb') })).toBe(at('d.ipynb'))
  expect(editedPathOf('Read', { file_path: at('a.ts') })).toBeUndefined()
  expect(editedPathOf('Bash', { command: 'sed -i s/a/b/ a.ts' })).toBeUndefined()
  expect(editedPathOf('Edit', { file_path: '  ' })).toBeUndefined()

  expect(editLanded({ result: { filePath: at('a.ts') } })).toBe(true)
  expect(editLanded({ deny: 'not here' })).toBe(false)
  expect(editLanded({ isError: true, result: 'boom' })).toBe(false)
  // Held for the machine owner to review: the file did not change.
  expect(editLanded({ result: { filePath: at('a.ts'), staged: true } })).toBe(false)
})

test('the command lines name the scope, do not lead with the plugin name, and offer no write or network', () => {
  expect(turnedOnLine(scoped('src/**', 'docs/**'))).toBe(
    'on · 2 globs from .claude/wait-scope · /wait-scope turns it off',
  )
  expect(turnedOnLine(fromSetting('src/**'))).toBe(
    'on · 1 glob from the Files in scope setting · /wait-scope turns it off',
  )
  expect(turnedOnLine(noScope)).toBe(
    'on · no scope set, so the paths your prompt names are a guess · /wait-scope turns it off',
  )
  expect(turnedOffLine()).toBe(
    'off · /wait-scope turns it back on · /plugin → wait-scope → Warn when a turn edits outside the scope',
  )
  expect(turnedOffLocallyLine('a managed setting owns it')).toBe(
    'off · the setting did not change (a managed setting owns it) · kept off on this machine · /wait-scope turns it back on',
  )
  expect(toggleRefusedLine('a managed setting owns it')).toBe(
    'still off · the setting did not change (a managed setting owns it) · ' +
      '/plugin → wait-scope → Warn when a turn edits outside the scope',
  )
  const lines = [turnedOnLine(noScope), turnedOffLine(), turnedOffLocallyLine('locked'), toggleRefusedLine('locked')]
  for (const line of lines) {
    // The engine prints `wait-scope:` in front. The settings path may name it; the line must not.
    expect(line).not.toMatch(/^wait-scope\b/)
    expect(line).not.toMatch(/\b(commit|push|pull|upload|revert|https?)\b/i)
  }
})

test("the enabled row is found under the installed name or a working copy's, and nothing else", () => {
  expect(enabledRowKey([{ key: 'theme' }, { key: 'wait-scope.enabled' }])).toBe('wait-scope.enabled')
  expect(enabledRowKey([{ key: 'wait-scope@inline.enabled' }])).toBe('wait-scope@inline.enabled')
  expect(enabledRowKey([{ key: 'wait-scope.globs' }, { key: 'wait-scope-x.enabled' }])).toBe('wait-scope.enabled')
  expect(enabledRowKey([])).toBe('wait-scope.enabled')
})

test('the row goes to every other waitroom mod first, as their own lists already have it', () => {
  expect(BAND_PRECEDENCE).toEqual(['wait-breathe', 'wait-changed', 'wait-ship', 'bet-on-your-agent', 'wait-scope'])
  for (const other of ['wait-breathe', 'wait-changed', 'wait-ship', 'bet-on-your-agent'] as const) {
    expect(yieldsBand('wait-scope', other)).toBe(true)
    expect(yieldsBand(other, 'wait-scope')).toBe(false)
  }
  expect(yieldsBand('wait-scope', undefined)).toBe(false)
  expect(yieldsBand('wait-scope', 'some-other-plugin')).toBe(false)
  expect(drawnBy({ type: 'Box', part: { plugin: 'wait-changed' } })).toBe('wait-changed')
  expect(drawnBy({ type: 'Box' })).toBeUndefined()
})
