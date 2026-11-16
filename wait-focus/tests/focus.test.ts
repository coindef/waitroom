import { expect, test } from 'claude-code/testing'

import {
  CLEARED,
  covers,
  columnWidth,
  decide,
  displayPath,
  EMPTY_PATH,
  focusKey,
  globLine,
  HELP,
  MAX_STAMPED,
  normalizeWatch,
  outsideLine,
  parseNameStatusZ,
  parseStageZ,
  planStamps,
  safeGitPath,
  showLine,
  stampsFor,
  statusLine,
  TOO_MANY,
  touchedPaths,
  toStored,
  verdicts,
  watchesFromStore,
  watchingLine,
  type Change,
} from '../hooks/focus'

const ROOT = '/repo'

test('a file and a folder normalize inside the project, and a missing path is still a path', () => {
  expect(normalizeWatch(ROOT, 'package.json')).toEqual({ ok: true, path: 'package.json' })
  expect(normalizeWatch(ROOT, 'src/auth/')).toEqual({ ok: true, path: 'src/auth/' })
  expect(normalizeWatch(ROOT, './src/./auth')).toEqual({ ok: true, path: 'src/auth' })
  expect(normalizeWatch(ROOT, '/repo/src/auth/')).toEqual({ ok: true, path: 'src/auth/' })
  expect(normalizeWatch(ROOT, 'src/missing.ts')).toEqual({ ok: true, path: 'src/missing.ts' })
  expect(normalizeWatch(`${ROOT}/`, 'package.json')).toEqual({ ok: true, path: 'package.json' })
})

test('a path outside the project is refused, including one that climbs out and an absolute one', () => {
  expect(normalizeWatch(ROOT, '../secret')).toEqual({ ok: false, reason: 'outside' })
  expect(normalizeWatch(ROOT, 'src/../../secret')).toEqual({ ok: false, reason: 'outside' })
  expect(normalizeWatch(ROOT, '/etc/passwd')).toEqual({ ok: false, reason: 'outside' })
  expect(normalizeWatch(ROOT, '/repo-other/file')).toEqual({ ok: false, reason: 'outside' })
  expect(outsideLine('../secret')).toBe('../secret is outside this repo · name a path inside it')
  expect(decide('../secret package.json', ROOT)).toEqual({
    type: 'reject',
    text: '../secret is outside this repo · name a path inside it',
  })
})

test('more than three paths is refused, and duplicates count once', () => {
  expect(decide('a b c d', ROOT)).toEqual({ type: 'reject', text: TOO_MANY })
  expect(TOO_MANY).toBe('3 paths max · name one to three, like src/auth/ or package.json')
  expect(decide('a a a a', ROOT)).toEqual({ type: 'set', paths: ['a'] })
  expect(decide('src/auth/ src/auth package.json', ROOT)).toEqual({
    type: 'set',
    paths: ['src/auth/', 'package.json'],
  })
  expect(decide('"my file.ts" package.json', ROOT)).toEqual({ type: 'set', paths: ['my file.ts', 'package.json'] })
})

test('/wait-focus with no list shows the help line, and clear is only the whole command', () => {
  expect(decide('', ROOT)).toEqual({ type: 'show' })
  expect(decide('   ', ROOT)).toEqual({ type: 'show' })
  expect(decide('clear', ROOT)).toEqual({ type: 'clear' })
  expect(decide('clear src/auth', ROOT)).toEqual({ type: 'set', paths: ['clear', 'src/auth'] })
  expect(HELP).toBe('/wait-focus src/auth/ or package.json · up to 3')
  expect(CLEARED).toBe('cleared')
  expect(decide('a', undefined)).toEqual({ type: 'reject', text: 'no paths kept · no project root' })
  expect(decide('a', 'relative/repo')).toEqual({ type: 'reject', text: 'no paths kept · no project root' })
  expect(decide('/', ROOT).type).toBe('reject')
  expect(decide('C:', ROOT)).toEqual({ type: 'reject', text: EMPTY_PATH })
})

test('a folder covers what is inside it, and a file covers only itself', () => {
  expect(covers('src/auth/', 'src/auth/login.ts')).toBe(true)
  expect(covers('src/auth', 'src/auth/login.ts')).toBe(true)
  expect(covers('src/auth/', 'src/auth')).toBe(true)
  expect(covers('src/auth/', 'src/auth2/login.ts')).toBe(false)
  expect(covers('package.json', 'package.json')).toBe(true)
  expect(covers('package.json', 'src/package.json')).toBe(false)
  expect(covers('.', 'src/auth/login.ts')).toBe(true)
})

test('touched, untouched, and a folder match', () => {
  const rows = verdicts(['src/auth/', 'package.json'], ['src/auth/login.ts'])
  expect(rows).toEqual([
    { path: 'src/auth/', touched: true },
    { path: 'package.json', touched: false },
  ])
  expect(statusLine(rows)).toBe('src/auth/ touched · package.json untouched')
  expect(statusLine(verdicts(['src/missing.ts'], []))).toBe('src/missing.ts untouched')
  expect(statusLine([])).toBeUndefined()
})

test('a rename and a delete land on the paths they name', () => {
  expect(parseNameStatusZ('D\0package.json\0')).toEqual([{ kind: 'absent', path: 'package.json' }])
  expect(parseNameStatusZ('R100\0src/auth/login.ts\0src/auth/session.ts\0')).toEqual([
    { kind: 'absent', path: 'src/auth/login.ts' },
    { kind: 'present', path: 'src/auth/session.ts' },
  ])
  expect(parseNameStatusZ('M\0src/auth/login.ts\0A\0src/new.ts\0')).toEqual([
    { kind: 'present', path: 'src/auth/login.ts' },
    { kind: 'present', path: 'src/new.ts' },
  ])

  const renamed = parseNameStatusZ('R100\0src/auth/login.ts\0src/auth/session.ts\0')
  const plan = planStamps(renamed, [], ['src/auth/', 'package.json'])
  expect(plan.ok).toBe(true)
  if (!plan.ok) return
  expect(plan.absent).toEqual(['src/auth/login.ts'])
  expect(plan.present).toEqual(['src/auth/session.ts'])
  const stamps = stampsFor(plan, new Map([['src/auth/session.ts', 'abc']]))
  expect(touchedPaths([], stamps ?? [])).toEqual(['src/auth/login.ts', 'src/auth/session.ts'])
  expect(verdicts(['src/auth/login.ts', 'package.json'], touchedPaths([], stamps ?? []))).toEqual([
    { path: 'src/auth/login.ts', touched: true },
    { path: 'package.json', touched: false },
  ])
})

test('a file that was already dirty is touched only when its hash changes', () => {
  const before = [{ path: 'package.json', stamp: 'aaa' }]
  expect(touchedPaths(before, [{ path: 'package.json', stamp: 'bbb' }])).toEqual(['package.json'])
  expect(touchedPaths(before, before)).toEqual([])
  expect(touchedPaths(before, [])).toEqual(['package.json'])
})

test('an untracked file uses its own stamp, so adding it to the index still counts', () => {
  const plan = planStamps([], ['src/auth/new.ts'], ['src/auth/'])
  expect(plan.ok).toBe(true)
  if (!plan.ok) return
  const stamps = stampsFor(plan, new Map([['src/auth/new.ts', 'hhh']]))
  expect(stamps).toEqual([{ path: 'src/auth/new.ts', stamp: 'new:hhh' }])
  expect(touchedPaths([], stamps ?? [])).toEqual(['src/auth/new.ts'])
  expect(touchedPaths(stamps ?? [], [{ path: 'src/auth/new.ts', stamp: 'hhh' }])).toEqual(['src/auth/new.ts'])
})

test('the four path checks refuse an empty path, a NUL, an absolute path, and a .. segment', () => {
  expect(safeGitPath('src/auth/login.ts')).toBe(true)
  expect(safeGitPath('')).toBe(false)
  expect(safeGitPath('src/a\0b.ts')).toBe(false)
  expect(safeGitPath('/etc/passwd')).toBe(false)
  expect(safeGitPath('src/../../secret')).toBe(false)
  expect(planStamps([{ kind: 'present', path: 'src/a\0b.ts' }], [], ['.']).ok).toBe(false)
  expect(planStamps([{ kind: 'present', path: '/etc/passwd' }], [], ['.']).ok).toBe(false)
  expect(planStamps([{ kind: 'present', path: 'src/../../secret' }], [], ['.']).ok).toBe(false)
})

test('a path that is not watched is not hashed, and an unsafe path fails the read', () => {
  const changes: Change[] = [
    { kind: 'present', path: 'src/auth/login.ts' },
    { kind: 'present', path: 'other.ts' },
  ]
  const plan = planStamps(changes, ['notes/a.txt'], ['src/auth/'])
  expect(plan).toEqual({ ok: true, present: ['src/auth/login.ts'], absent: [], untracked: [], linked: [] })
  expect(planStamps([{ kind: 'present', path: '../secret' }], [], ['.']).ok).toBe(false)
})

test('more files than the cap fails the read instead of guessing', () => {
  const changes: Change[] = Array.from({ length: MAX_STAMPED + 1 }, (_, index) => ({
    kind: 'present' as const,
    path: `src/f${index}.ts`,
  }))
  expect(planStamps(changes, [], ['src/']).ok).toBe(false)
  expect(planStamps(changes.slice(0, MAX_STAMPED), [], ['src/']).ok).toBe(true)
})

test('a missing hash fails the stamps, so the caller cannot call that file untouched', () => {
  expect(stampsFor({ present: ['package.json'], absent: [], untracked: [] }, new Map())).toBeUndefined()
  expect(stampsFor({ present: [], absent: ['package.json'], untracked: [] }, new Map())).toEqual([
    { path: 'package.json', stamp: 'absent' },
  ])
})

test('a long path loses folders from the left, and every touched or untouched stays', () => {
  expect(
    statusLine([
      { path: 'src/auth/', touched: true },
      { path: 'package.json', touched: false },
    ]),
  ).toBe('src/auth/ touched · package.json untouched')
  expect(
    statusLine([
      { path: 'src/components/auth/LoginForm.tsx', touched: true },
      { path: 'package.json', touched: false },
    ]),
  ).toBe('…/LoginForm.tsx touched · package.json untouched')
  const longName = statusLine([{ path: `src/${'a'.repeat(40)}.ts`, touched: true }])
  expect(longName).toBe(`…/${'a'.repeat(40)}.ts touched`)
  expect(longName?.endsWith('touched')).toBe(true)
})

test('three typical paths fit in 48 columns and every verdict stays', () => {
  const line = statusLine([
    { path: 'src/auth/', touched: true },
    { path: 'package.json', touched: false },
    { path: 'README.md', touched: false },
  ])
  expect(line).toBe('…/auth/ yes · package.json no · README.md no')
  expect(columnWidth(line ?? '')).toBeLessThanOrEqual(48)
  expect(line?.includes('…/auth/ yes')).toBe(true)
  expect(line?.includes('package.json no')).toBe(true)
  expect(line?.includes('README.md no')).toBe(true)
})

test('bidi marks and C1 controls are stripped from a displayed path', () => {
  expect(displayPath('src/\u200Eauth/\u202Elogin.ts')).toBe('src/auth/login.ts')
  expect(displayPath('src/\u202Aauth\u202B/\u202C\u202D\u202E\u2066\u2067\u2068\u2069x')).toBe('src/auth/x')
  expect(displayPath('src/\u0085auth\u009F.ts')).toBe('src/auth.ts')
  expect(statusLine([{ path: 'src/\u202Eauth/login.ts', touched: true }])).toBe('src/auth/login.ts touched')
  expect(watchingLine(['src/\u200Eauth'], [], true)).toBe('watching src/auth')
  expect(outsideLine('../\u202Esecret\u0085')).toBe('../secret is outside this repo · name a path inside it')
  expect(globLine('src/\u202Eauth/*\u009F')).toBe(
    'src/auth/* looks like a glob · name a file or folder, like src/auth/ or package.json',
  )
})

test('a CJK path is measured in display columns and stays within 48', () => {
  const wide = `${'あ'.repeat(30)}.ts`
  const line = statusLine([{ path: `src/${wide}`, touched: true }])
  expect(line?.endsWith('yes') || line?.endsWith('touched')).toBe(true)
  expect(line?.startsWith('…/')).toBe(true)
  expect(columnWidth(line ?? '')).toBeLessThanOrEqual(48)
  expect(line).not.toBe(`src/${wide} touched`)
  expect(statusLine([{ path: '認証.ts', touched: false }])).toBe('認証.ts untouched')
})

test('a symlink and a submodule are hints, not untouched', () => {
  expect(parseStageZ(`120000 ${'a'.repeat(40)} 0\tlink.json\0`)).toEqual([
    { path: 'link.json', kind: 'symlink', sha: 'a'.repeat(40) },
  ])
  expect(parseStageZ(`160000 ${'b'.repeat(40)} 0\tvendor\0`)).toEqual([
    { path: 'vendor', kind: 'submodule', sha: 'b'.repeat(40) },
  ])
  expect(verdicts(['link.json', 'package.json'], [], [{ path: 'link.json', kind: 'symlink' }])).toEqual([
    { path: 'link.json', touched: false, hint: 'symlink' },
    { path: 'package.json', touched: false },
  ])
  expect(
    statusLine([
      { path: 'link.json', touched: false, hint: 'symlink' },
      { path: 'package.json', touched: false },
    ]),
  ).toBe('link.json is a symlink · package.json untouched')
})

test('a glob is refused and does not become a path that would always read untouched', () => {
  expect(decide('src/**/*.ts', ROOT)).toEqual({
    type: 'reject',
    text: 'src/**/*.ts looks like a glob · name a file or folder, like src/auth/ or package.json',
  })
  expect(decide('src/auth/*', ROOT)).toEqual({ type: 'reject', text: globLine('src/auth/*') })
  expect(decide('package.json src/**/*.ts', ROOT).type).toBe('reject')
  expect(decide('src/[ab].ts', ROOT).type).toBe('reject')
})

test('the reply names a path that is not on disk, and a directory that is not a git repo', () => {
  expect(watchingLine(['src/missing.ts', 'package.json'], ['src/missing.ts'], true)).toBe(
    'watching src/missing.ts (not on disk yet) · package.json',
  )
  expect(watchingLine(['src/auth/'], [], false)).toBe(
    'watching src/auth/ · not a git repo, so a turn here stays quiet',
  )
  expect(showLine([], [], true)).toBe(HELP)
})

test('the store key follows the project root, and a value this mod did not write is no list', () => {
  expect(focusKey('/repo')).toBe(focusKey('/repo/'))
  expect(focusKey('/repo')).not.toBe(focusKey('/other'))
  expect(focusKey('repo')).toBeUndefined()
  expect(focusKey('C:/repo')).toBe(focusKey('c:/repo/'))
  const stored = toStored(['src/auth/', 'package.json'])
  expect(watchesFromStore(stored)).toEqual(['src/auth/', 'package.json'])
  expect(watchesFromStore(undefined)).toEqual([])
  expect(watchesFromStore({ v: 2, paths: ['a'] })).toEqual([])
  expect(watchesFromStore({ v: 1, paths: ['a', 'b', 'c', 'd'] })).toEqual(['a', 'b', 'c'])
})
