/**
 * Pure selection and copy: oldest TODO from grep+blame, seen/skip, merged
 * branches from origin/HEAD, status and log lines, and no mutating command
 * is ever constructed as something to run.
 *
 * Requires `claude plugin test`.
 */

import { expect, test } from 'claude-code/testing'

import {
  ageLine,
  branchLogLine,
  commentText,
  defaultBranchName,
  mutatingGitArgv,
  oldestTodo,
  parseBlameTime,
  parseChoreCommand,
  parseGrep,
  parseMergedBranches,
  parseOriginHead,
  pickDeadBranch,
  pickTodo,
  recordsFromStore,
  statusFor,
  todoId,
  todoLogLine,
  toStored,
  USAGE,
  type TodoHit,
} from '../hooks/chore'

const hit = (path: string, line: number, text: string, at: number): TodoHit => ({ path, line, text, at })

const NOW = Date.UTC(2026, 10, 27, 16, 0, 0) // 2026-11-27 16:00 UTC

test('parseGrep reads path, line and the rest of the line', () => {
  const rows = parseGrep('src/a.ts:12:  // TODO: fix this\nlib/b.ts:3:# FIXME later\n')
  expect(rows).toEqual([
    { path: 'src/a.ts', line: 12, raw: '  // TODO: fix this' },
    { path: 'lib/b.ts', line: 3, raw: '# FIXME later' },
  ])
})

test('parseGrep skips a line that is not path:line:text', () => {
  expect(parseGrep('not a hit\n')).toEqual([])
  expect(parseGrep('')).toEqual([])
})

test('commentText takes the words after TODO or FIXME, and a bare tag is the tag', () => {
  expect(commentText('  // TODO: fix the flaky test')).toBe('fix the flaky test')
  expect(commentText('  # FIXME later')).toBe('later')
  expect(commentText('  // TODO')).toBe('TODO')
  expect(commentText('  /* FIXME: */')).toBe('FIXME')
})

test('commentText is case-sensitive and does not treat todo as a hit', () => {
  expect(commentText('  // todo: lowercase')).toBe('todo: lowercase')
})

test('parseBlameTime reads author-time from porcelain', () => {
  const porcelain = [
    'abc123 12 12 1',
    'author A',
    'author-mail <a@b.c>',
    'author-time 1609459200',
    'author-tz +0000',
    'committer A',
    'committer-time 1609459200',
    'filename src/a.ts',
    '\t  // TODO: fix this',
    '',
  ].join('\n')
  expect(parseBlameTime(porcelain)).toBe(1609459200)
})

test('parseBlameTime is undefined when author-time is missing', () => {
  expect(parseBlameTime('author A\n')).toBeUndefined()
})

test('oldestTodo picks the earliest blame date, then path, then line', () => {
  const older = hit('b.ts', 2, 'old', 1000)
  const newer = hit('a.ts', 1, 'new', 2000)
  expect(oldestTodo([newer, older])).toEqual(older)
  const sameDateA = hit('a.ts', 9, 'x', 1000)
  const sameDateB = hit('a.ts', 3, 'y', 1000)
  expect(oldestTodo([sameDateA, sameDateB])).toEqual(sameDateB)
  const pathB = hit('b.ts', 1, 'z', 1000)
  expect(oldestTodo([pathB, sameDateB])).toEqual(sameDateB)
})

test('oldestTodo of an empty list is undefined', () => {
  expect(oldestTodo([])).toBeUndefined()
})

test('pickTodo skips a seen item and returns the next oldest', () => {
  const old = hit('a.ts', 1, 'old', 1000)
  const mid = hit('b.ts', 1, 'mid', 2000)
  const seen = [todoId(old)]
  expect(pickTodo([old, mid], seen, [])).toEqual(mid)
})

test('pickTodo skips a skipped item while another eligible one exists', () => {
  const old = hit('a.ts', 1, 'old', 1000)
  const mid = hit('b.ts', 1, 'mid', 2000)
  expect(pickTodo([old, mid], [], [todoId(old)])).toEqual(mid)
})

test('pickTodo returns a skipped item once only skipped items remain', () => {
  const old = hit('a.ts', 1, 'old', 1000)
  const mid = hit('b.ts', 1, 'mid', 2000)
  expect(pickTodo([old, mid], [], [todoId(old), todoId(mid)])).toEqual(old)
})

test('pickTodo returns undefined when every item is seen', () => {
  const old = hit('a.ts', 1, 'old', 1000)
  expect(pickTodo([old], [todoId(old)], [])).toBeUndefined()
})

test('todoId is path, line and text, so an edited comment is a new item', () => {
  expect(todoId(hit('a.ts', 1, 'old', 0))).not.toBe(todoId(hit('a.ts', 1, 'changed', 0)))
  expect(todoId(hit('a.ts', 1, 'old', 0))).not.toBe(todoId(hit('a.ts', 2, 'old', 0)))
})

test('parseOriginHead reads a remote symbolic ref and nothing else', () => {
  expect(parseOriginHead('refs/remotes/origin/develop\n')).toBe('refs/remotes/origin/develop')
  expect(parseOriginHead('refs/remotes/origin/main\n')).toBe('refs/remotes/origin/main')
  expect(parseOriginHead('')).toBeUndefined()
  expect(parseOriginHead('master\n')).toBeUndefined()
})

test('defaultBranchName is the last segment of origin/HEAD, not a guessed name', () => {
  expect(defaultBranchName('refs/remotes/origin/develop')).toBe('develop')
  expect(defaultBranchName('refs/remotes/origin/main')).toBe('main')
})

test('parseMergedBranches keeps only local names, not the default and not the current branch', () => {
  const stdout = '  leftover\n* develop\n  also-gone\n  develop\n'
  expect(parseMergedBranches(stdout, 'develop', 'develop')).toEqual(['also-gone', 'leftover'])
})

test('parseMergedBranches is empty when origin/HEAD is missing, because there is no list to parse', () => {
  // The fallback lives in the hooks: no origin/HEAD means this is not called.
  expect(parseMergedBranches('', 'develop', 'develop')).toEqual([])
})

test('pickDeadBranch returns one name, stably by alphabet', () => {
  expect(pickDeadBranch(['zeta', 'alpha', 'mu'])).toBe('alpha')
  expect(pickDeadBranch([])).toBeUndefined()
})

test('ageLine is today, days, or years in plain English', () => {
  expect(ageLine(NOW, NOW)).toBe('today')
  expect(ageLine(NOW - 12 * 86400000, NOW)).toBe('12 days old')
  expect(ageLine(NOW - 1 * 86400000, NOW)).toBe('1 day old')
  expect(ageLine(NOW - 3 * 365 * 86400000, NOW)).toBe('3 years old')
  expect(ageLine(NOW - 365 * 86400000, NOW)).toBe('1 year old')
})

test('statusFor during a wait is only the TODO text, plus a branch name when there is one', () => {
  expect(statusFor('fix the flaky test', undefined)).toBe('fix the flaky test')
  expect(statusFor('fix the flaky test', 'leftover')).toBe('fix the flaky test · leftover')
  expect(statusFor(undefined, 'leftover')).toBe('leftover')
  expect(statusFor(undefined, undefined)).toBeUndefined()
})

test('todoLogLine is file, line and age, and branchLogLine is git branch -d', () => {
  const item = hit('src/a.ts', 12, 'fix the flaky test', NOW - 12 * 86400000)
  expect(todoLogLine(item, NOW)).toBe('src/a.ts:12 · 12 days old')
  expect(branchLogLine('leftover')).toBe('git branch -d leftover')
})

test('parseChoreCommand accepts only seen and skip', () => {
  expect(parseChoreCommand('seen')).toBe('seen')
  expect(parseChoreCommand('  skip  ')).toBe('skip')
  expect(parseChoreCommand('')).toBe('invalid')
  expect(parseChoreCommand('d')).toBe('invalid')
  expect(parseChoreCommand('s')).toBe('invalid')
  expect(USAGE).toBe('/chore seen · /chore skip')
})

test('recordsFromStore reads a list of ids, and a bad value is invalid', () => {
  expect(recordsFromStore(undefined)).toBeUndefined()
  expect(recordsFromStore(toStored(['a', 'b']))).toEqual(['a', 'b'])
  expect(recordsFromStore({ v: 1, ids: 'nope' })).toBe('invalid')
  expect(recordsFromStore({ v: 2, ids: ['a'] })).toBe('invalid')
  expect(recordsFromStore(['a'])).toBe('invalid')
})

test('mutatingGitArgv is true only for a git write or delete, not for grep or blame or --merged', () => {
  expect(mutatingGitArgv(['git', 'grep', '-n', '-e', 'TODO'])).toBe(false)
  expect(mutatingGitArgv(['git', 'blame', '--line-porcelain', '-L', '1,1', '--', 'a.ts'])).toBe(false)
  expect(mutatingGitArgv(['git', 'branch', '--merged', 'refs/remotes/origin/develop'])).toBe(false)
  expect(mutatingGitArgv(['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'])).toBe(false)
  expect(mutatingGitArgv(['git', 'branch', '-d', 'leftover'])).toBe(true)
  expect(mutatingGitArgv(['git', 'branch', '-D', 'leftover'])).toBe(true)
  expect(mutatingGitArgv(['git', 'checkout', 'leftover'])).toBe(true)
  expect(mutatingGitArgv(['git', 'commit', '-m', 'x'])).toBe(true)
})
