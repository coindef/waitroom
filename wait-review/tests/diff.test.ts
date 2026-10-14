import { expect, test } from 'claude-code/testing'

import type { Hunk } from '../types'
import {
  mergeHunks,
  nextHunk,
  parseDiff,
  reviewNote,
  sidePath,
  tally,
  toRepoPath,
  trimHunk,
} from '../hooks/diff'

/** `git diff --no-prefix` over two edited files and one added file. */
const DIFF = [
  'diff --git hooks/diff.ts hooks/diff.ts',
  'index 1234567..89abcde 100644',
  '--- hooks/diff.ts',
  '+++ hooks/diff.ts',
  '@@ -1,4 +1,5 @@',
  " import type { Hunk } from '../types'",
  ' ',
  '+const NEW = 1',
  ' export const hash = (text: string): string => {',
  '   let value = 0x811c9dc5',
  '@@ -20,5 +21,6 @@ export const parseDiff = (output: string) => {',
  '   const hunks: Hunk[] = []',
  "-  let minus = ''",
  "+  let minus = undefined",
  "+  let extra = ''",
  "   let plus = ''",
  "   let path = ''",
  'diff --git README.md README.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ README.md',
  '@@ -0,0 +1,2 @@',
  '+# wait-review',
  '+',
  '',
].join('\n')

const hunk = (over: Partial<Hunk>): Hunk => ({
  id: 'id',
  path: 'a.ts',
  header: '@@ -1,1 +1,1 @@',
  text: '@@ -1,1 +1,1 @@\n-a\n+b',
  added: 1,
  removed: 1,
  status: 'pending',
  ...over,
})

test('every hunk of every file in one diff becomes its own card', async () => {
  const found = parseDiff(DIFF)

  expect(found).toHaveLength(3)
  expect(found.map(one => one.path)).toEqual(['hooks/diff.ts', 'hooks/diff.ts', 'README.md'])
  expect(found[0]?.added).toBe(1)
  expect(found[0]?.removed).toBe(0)
  expect(found[1]?.added).toBe(2)
  expect(found[1]?.removed).toBe(1)
  expect(found[2]?.added).toBe(2)
})

test('a hunk carries its own header and body, ready to draw as a diff', async () => {
  const found = parseDiff(DIFF)

  expect(found[0]?.header).toBe('@@ -1,4 +1,5 @@')
  expect(found[0]?.text.startsWith('@@ -1,4 +1,5 @@\n')).toBe(true)
  expect(found[0]?.text).toContain('+const NEW = 1')
  // One card holds one hunk: the next hunk's header is not in it.
  expect(found[0]?.text).not.toContain('@@ -20,5')
})

test('a file added whole takes its path from the + side, not /dev/null', async () => {
  const added = parseDiff(DIFF).filter(one => one.path === 'README.md')

  expect(added).toHaveLength(1)
  expect(added[0]?.removed).toBe(0)
})

test('a file deleted whole takes its path from the - side', async () => {
  const found = parseDiff([
    'diff --git old.txt old.txt',
    '--- old.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-gone',
    '-also gone',
  ].join('\n'))

  expect(found).toHaveLength(1)
  expect(found[0]?.path).toBe('old.txt')
  expect(found[0]?.removed).toBe(2)
  expect(found[0]?.added).toBe(0)
})

test('an id follows the hunk text, so a rewrite comes back as a new hunk', async () => {
  const first = parseDiff(DIFF)
  const again = parseDiff(DIFF)
  const changed = parseDiff(DIFF.replace('+const NEW = 1', '+const NEW = 2'))

  expect(again[0]?.id).toBe(first[0]?.id)
  expect(changed[0]?.id).not.toBe(first[0]?.id)
  // The untouched hunks of the same file keep their ids.
  expect(changed[1]?.id).toBe(first[1]?.id)
})

test('output that is not a diff yields no cards rather than a broken one', async () => {
  expect(parseDiff('')).toEqual([])
  expect(parseDiff('fatal: bad revision')).toEqual([])
})

test('a trimmed hunk header counts the lines actually kept', async () => {
  const text = ['@@ -1,4 +1,5 @@', ' one', ' two', '+three', '-four', ' five'].join('\n')
  const cut = trimHunk(text, 3)
  const lines = cut.text.split('\n')

  expect(cut.hidden).toBe(2)
  expect(lines).toHaveLength(4)
  // Two context lines plus one added: 2 on the - side, 3 on the +.
  expect(lines[0]).toBe('@@ -1,2 +1,3 @@')
})

test('a hunk shorter than the room is left exactly as it was', async () => {
  const text = ['@@ -1,1 +1,2 @@', ' one', '+two'].join('\n')

  expect(trimHunk(text, 10)).toEqual({ text, hidden: 0 })
})

test('a trimmed hunk still parses as the one hunk it is', async () => {
  const long = ['@@ -1,6 +1,6 @@', ' a', ' b', ' c', '-d', '+D', ' e'].join('\n')
  const cut = trimHunk(long, 4)
  const reparsed = parseDiff(['--- x.ts', '+++ x.ts', cut.text].join('\n'))

  expect(reparsed).toHaveLength(1)
  expect(reparsed[0]?.path).toBe('x.ts')
})

test('a rescan keeps what the person already decided', async () => {
  const reviewed = hunk({ id: 'a@1', path: 'a.ts', status: 'ok' })
  const fresh = hunk({ id: 'b@1', path: 'a.ts' })
  const merged = mergeHunks([reviewed], [hunk({ id: 'a@1', path: 'a.ts' }), fresh], ['a.ts'])

  expect(merged).toHaveLength(2)
  expect(merged.find(one => one.id === 'a@1')?.status).toBe('ok')
  expect(merged.find(one => one.id === 'b@1')?.status).toBe('pending')
})

test('a rescan drops hunks the agent has since reverted', async () => {
  const stale = hunk({ id: 'a@1', path: 'a.ts', status: 'ok' })
  const other = hunk({ id: 'z@1', path: 'untouched.ts', status: 'flagged' })

  const merged = mergeHunks([stale, other], [], ['a.ts'])

  // a.ts was asked about and answered with nothing, so its card goes; a file
  // the scan never asked about keeps its cards.
  expect(merged.map(one => one.id)).toEqual(['z@1'])
})

test('the queue offers what is pending before what was put off', async () => {
  const later = hunk({ id: 'l', status: 'later' })
  const pending = hunk({ id: 'p', status: 'pending' })

  expect(nextHunk([later, pending])?.id).toBe('p')
  expect(nextHunk([later])?.id).toBe('l')
  expect(nextHunk([hunk({ status: 'ok' }), hunk({ id: 's', status: 'sent' })])).toBeUndefined()
})

test('the tally separates what is read, flagged and already sent', async () => {
  const counts = tally([
    hunk({ id: '1', status: 'pending' }),
    hunk({ id: '2', status: 'pending' }),
    hunk({ id: '3', status: 'ok' }),
    hunk({ id: '4', status: 'sent' }),
    hunk({ id: '5', status: 'flagged' }),
    hunk({ id: '6', status: 'later' }),
  ])

  expect(counts).toEqual({ pending: 2, later: 1, flagged: 1, reviewed: 2 })
})

test('review notes carry each flagged hunk as the diff that was read', async () => {
  const note = reviewNote([
    hunk({ id: '1', path: 'src/auth.ts', text: '@@ -1,1 +1,1 @@\n-weak\n+strong' }),
    hunk({ id: '2', path: 'src/db.ts' }),
  ])

  expect(note).toContain('src/auth.ts')
  expect(note).toContain('src/db.ts')
  expect(note).toContain('```diff')
  expect(note).toContain('+strong')
})

test('review notes stay bounded, and say how many they left out', async () => {
  const body = `@@ -1,1 +1,1 @@\n+${'x'.repeat(4000)}`
  const many = Array.from({ length: 12 }, (_, at) =>
    hunk({ id: `h${at}`, path: `file${at}.ts`, text: body }),
  )

  const note = reviewNote(many)

  expect(note.length).toBeLessThan(20000)
  expect(note).toContain('more flagged hunk')
})

test('a path holding a space keeps neither the tab git ends it with nor quotes', async () => {
  // Real `git diff --no-prefix` output: a name with a space gets a trailing tab.
  expect(sidePath('dir with space/spaced name.txt\t')).toBe('dir with space/spaced name.txt')
  expect(sidePath('plain.txt')).toBe('plain.txt')
  expect(sidePath('"quoted name.txt"')).toBe('quoted name.txt')
  expect(sidePath('/dev/null')).toBe('/dev/null')
})

test('a hunk for a spaced path is keyed on the name without the tab', async () => {
  const found = parseDiff([
    'diff --git dir a/f.txt dir a/f.txt',
    '--- dir a/f.txt\t',
    '+++ dir a/f.txt\t',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n'))

  expect(found[0]?.path).toBe('dir a/f.txt')
  expect(found[0]?.id.startsWith('dir a/f.txt@')).toBe(true)
})

test('an absolute path from a tool becomes the path git prints', async () => {
  // Edit and Write carry absolute paths; git prints relative ones. A rescan can
  // only recognise or retire a hunk when the two spellings agree.
  expect(toRepoPath('/home/user/Plugin', '/home/user/Plugin/hooks/diff.ts')).toBe('hooks/diff.ts')
  expect(toRepoPath('/home/user/Plugin/', '/home/user/Plugin/a.ts')).toBe('a.ts')
  expect(toRepoPath('/home/user/Plugin', 'hooks/diff.ts')).toBe('hooks/diff.ts')
  expect(toRepoPath('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts')).toBe('src/a.ts')
})

test('a path outside the repository is left absolute, so the scan can skip it', async () => {
  expect(toRepoPath('/home/user/Plugin', '/etc/passwd')).toBe('/etc/passwd')
})

test('a rescan retires a reverted hunk once both sides speak git paths', async () => {
  // The regression this guards: with an absolute path on the card and a
  // relative one in the scan, nothing ever matched and every hunk was kept.
  const card = hunk({ id: 'a@1', path: 'hooks/diff.ts', status: 'ok' })
  const asked = [toRepoPath('/home/user/Plugin', '/home/user/Plugin/hooks/diff.ts')]

  expect(mergeHunks([card], [], asked)).toEqual([])
})

test('a rescan that finds the same hunk does not hold it twice', async () => {
  const card = hunk({ id: 'a@1', path: 'hooks/diff.ts', status: 'ok' })
  const again = hunk({ id: 'a@1', path: 'hooks/diff.ts' })

  const merged = mergeHunks([card], [again], ['hooks/diff.ts'])

  expect(merged).toHaveLength(1)
  expect(merged[0]?.status).toBe('ok')
})
