import { expect, test } from 'claude-code/testing'

import type { Hunk, SessionStats } from '../types'
import {
  DEFAULT_IGNORE,
  EMPTY_SESSION,
  filledCells,
  globToRegExp,
  gradeOf,
  isIgnored,
  mergeHunks,
  isNarrowPlacement,
  paneHint,
  progressOf,
  reviewable,
  sessionSummaryLine,
  summaryOf,
  nextHunk,
  parseDiff,
  parseIgnore,
  reviewNote,
  sidePath,
  linesThatFit,
  rowsFor,
  sliceHunk,
  sortHunks,
  tally,
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
  start: 1,
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
  const merged = mergeHunks([reviewed], [hunk({ id: 'a@1', path: 'a.ts' }), fresh])

  expect(merged).toHaveLength(2)
  expect(merged.find(one => one.id === 'a@1')?.status).toBe('ok')
  expect(merged.find(one => one.id === 'b@1')?.status).toBe('pending')
})

test('a rescan drops hunks the agent has since reverted', async () => {
  const stale = hunk({ id: 'a@1', path: 'a.ts', status: 'ok' })
  const other = hunk({ id: 'z@1', path: 'untouched.ts', status: 'flagged' })

  const merged = mergeHunks([stale, other], [])

  // The scan reads the whole repository, so finding nothing left means there
  // is nothing left to review.
  expect(merged).toEqual([])
})

test('the queue offers what is pending before what was put off', async () => {
  const later = hunk({ id: 'l', status: 'later' })
  const pending = hunk({ id: 'p', status: 'pending' })

  expect(nextHunk([later, pending])?.id).toBe('p')
  expect(nextHunk([later])?.id).toBe('l')
  expect(nextHunk([hunk({ status: 'ok' }), hunk({ id: 's', status: 'sent' })])).toBeUndefined()
})

test('a hunk knows where in the file it starts', async () => {
  const found = parseDiff(DIFF)

  expect(found[0]?.start).toBe(1)
  expect(found[1]?.start).toBe(21)
  expect(found[2]?.start).toBe(1)
})

test('the queue reads a file top to bottom, one file at a time', async () => {
  const sorted = sortHunks([
    hunk({ id: 'b2', path: 'b.ts', start: 90 }),
    hunk({ id: 'a2', path: 'a.ts', start: 40 }),
    hunk({ id: 'b1', path: 'b.ts', start: 10 }),
    hunk({ id: 'a1', path: 'a.ts', start: 5 }),
  ])

  expect(sorted.map(one => one.id)).toEqual(['a1', 'a2', 'b1', 'b2'])
})

test('a merge leaves the queue in reading order however the scans arrived', async () => {
  const merged = mergeHunks(
    [hunk({ id: 'a2', path: 'a.ts', start: 70, status: 'ok' })],
    [hunk({ id: 'a2', path: 'a.ts', start: 70 }), hunk({ id: 'a1', path: 'a.ts', start: 2 })],
  )

  expect(merged.map(one => one.id)).toEqual(['a1', 'a2'])
  expect(merged[1]?.status).toBe('ok')
})

test('a capped queue drops the oldest hunks, not every late-alphabet file', async () => {
  const found = [
    hunk({ id: 'a', path: 'a.ts', start: 1 }),
    hunk({ id: 'z', path: 'z.ts', start: 1 }),
  ]
  const merged = mergeHunks([], found, 1)

  // One survives, and it is the newest found rather than the alphabetical first.
  expect(merged).toHaveLength(1)
  expect(merged[0]?.id).toBe('z')
})

test('a glob matches a path whether it is spelled relative or absolute', async () => {
  expect(globToRegExp('**/package-lock.json').test('package-lock.json')).toBe(true)
  expect(globToRegExp('**/package-lock.json').test('/home/me/app/package-lock.json')).toBe(true)
  expect(globToRegExp('**/package-lock.json').test('src/package-lock.json.ts')).toBe(false)
})

test('a glob keeps * inside one segment and ** across them', async () => {
  expect(globToRegExp('*.snap').test('a.snap')).toBe(true)
  expect(globToRegExp('*.snap').test('dir/a.snap')).toBe(false)
  expect(globToRegExp('**/dist/**').test('/app/dist/js/a.js')).toBe(true)
  expect(globToRegExp('**/dist/**').test('/app/src/a.js')).toBe(false)
  expect(globToRegExp('a?.ts').test('a1.ts')).toBe(true)
  expect(globToRegExp('a?.ts').test('a12.ts')).toBe(false)
})

test('a dot in a pattern is a dot, not any character', async () => {
  expect(globToRegExp('**/*.map').test('/app/a.map')).toBe(true)
  expect(globToRegExp('**/*.map').test('/app/axmap')).toBe(false)
})

test('the built-in list covers the files nobody reviews', async () => {
  const patterns = parseIgnore(DEFAULT_IGNORE)

  for (const path of [
    '/app/package-lock.json',
    '/app/pnpm-lock.yaml',
    '/app/Cargo.lock',
    '/app/go.sum',
    '/app/dist/main.js',
    '/app/coverage/lcov.info',
    '/app/src/__snapshots__/a.snap',
    '/app/vendor/thing.min.js',
    '/app/out/bundle.js.map',
  ]) {
    expect(isIgnored(path, patterns)).toBe(true)
  }

  // The code itself is never swept up with it.
  for (const path of ['/app/src/index.ts', '/app/hooks/diff.ts', '/app/README.md']) {
    expect(isIgnored(path, patterns)).toBe(false)
  }
})

test('an ignore list is read off commas and newlines, blanks dropped', async () => {
  expect(parseIgnore('a, b\n c ,,')).toEqual(['a', 'b', 'c'])
  expect(parseIgnore('')).toEqual([])
  expect(isIgnored('x.ts', [])).toBe(false)
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

  expect(counts).toEqual({ pending: 2, later: 1, flagged: 1, reviewed: 2, dropped: 0 })
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

test('a rescan that finds the same hunk does not hold it twice', async () => {
  const card = hunk({ id: 'a@1', path: 'hooks/diff.ts', status: 'ok' })
  const again = hunk({ id: 'a@1', path: 'hooks/diff.ts' })

  const merged = mergeHunks([card], [again])

  expect(merged).toHaveLength(1)
  expect(merged[0]?.status).toBe('ok')
})

test('a dropped hunk counts as dropped, never as reviewed', async () => {
  const counts = tally([hunk({ id: '1', status: 'dropped' }), hunk({ id: '2', status: 'ok' })])

  // Waving a file away is not the same as having read it.
  expect(counts.dropped).toBe(1)
  expect(counts.reviewed).toBe(1)
})

test('a dropped hunk is never offered again', async () => {
  expect(nextHunk([hunk({ id: 'd', status: 'dropped' })])).toBeUndefined()
})

test('a note the person wrote rides along with the hunk they flagged', async () => {
  const note = reviewNote([
    hunk({ id: '1', path: 'src/auth.ts', note: 'this drops the retry on 5xx' }),
    hunk({ id: '2', path: 'src/db.ts' }),
  ])

  expect(note).toContain('they said: this drops the retry on 5xx')
  // A hunk with no note says nothing extra, rather than an empty line.
  expect(note).not.toContain('they said: \n')
})

test('a hunk with no note reads exactly as it did before notes existed', async () => {
  const plain = reviewNote([hunk({ id: '1', path: 'a.ts' })])

  expect(plain).not.toContain('they said')
})

test('work already uncommitted when the session began is not the agent\'s review', async () => {
  const mine = hunk({ id: 'mine@1', path: 'src/wip.ts' })
  const theirs = hunk({ id: 'theirs@1', path: 'src/auth.ts' })

  const offered = reviewable([mine, theirs], [], ['mine@1'])

  expect(offered.map(one => one.id)).toEqual(['theirs@1'])
})

test('an ignored file is left out however it came to be written', async () => {
  const lock = hunk({ id: 'l@1', path: 'package-lock.json' })
  const code = hunk({ id: 'c@1', path: 'src/a.ts' })

  const offered = reviewable([lock, code], parseIgnore(DEFAULT_IGNORE), [])

  expect(offered.map(one => one.id)).toEqual(['c@1'])
})

test('the header says how much is left here and in all', async () => {
  const list = [
    hunk({ id: 'a1', path: 'a.ts', start: 1 }),
    hunk({ id: 'a2', path: 'a.ts', start: 40 }),
    hunk({ id: 'b1', path: 'b.ts', start: 1 }),
    hunk({ id: 'c1', path: 'c.ts', start: 1, status: 'ok' }),
  ]

  const where = progressOf(list, list[0] as never)

  expect(where.hereLeft).toBe(2)
  expect(where.totalLeft).toBe(3)
  expect(where.atFile).toBe(1)
  // c.ts is read, so it is not among the files with anything left.
  expect(where.ofFiles).toBe(2)
})

test('progress counts a hunk put off as still to come', async () => {
  const list = [hunk({ id: 'a', status: 'later' }), hunk({ id: 'b', status: 'dropped' })]

  const where = progressOf(list, list[0] as never)

  expect(where.totalLeft).toBe(1)
})

test('the counts line leaves out every zero', async () => {
  expect(summaryOf([hunk({ id: 'a' })])).toBe('1 to read')
  expect(summaryOf([])).toBe('')

  const mixed = summaryOf([
    hunk({ id: 'a', status: 'pending' }),
    hunk({ id: 'b', status: 'ok' }),
    hunk({ id: 'c', status: 'flagged' }),
  ])

  expect(mixed).toBe('1 to read · 1 read · 1 flagged')
  expect(mixed).not.toContain('0 ')
})

/** A new file of `n` lines, as git writes it: one hunk as long as the file. */
const newFile = (n: number) =>
  ['@@ -0,0 +1,' + n + ' @@', ...Array.from({ length: n }, (_, at) => `+line ${at + 1}`)].join('\n')

/** The counts a header states, against the counts its own body has. */
const agrees = (text: string): boolean => {
  const [header = '', ...body] = text.split('\n')
  const head = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header)
  if (!head) return false
  const minus = body.filter(line => !line.startsWith('+') && !line.startsWith('\\')).length
  const plus = body.filter(line => !line.startsWith('-') && !line.startsWith('\\')).length

  return Number(head[1] ?? 1) === minus && Number(head[2] ?? 1) === plus
}

test('a hunk that fits is drawn exactly as git wrote it', async () => {
  const text = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B'].join('\n')

  expect(sliceHunk(text, 0, 30)).toEqual({ text, first: 0, last: 3, total: 3 })
})

test('a new file longer than the pane can be read to its end, page by page', async () => {
  // The bug this guards: a new file is one hunk, and cutting every hunk to the
  // pane meant the rest of it could never be seen at all.
  const file = newFile(70)
  const one = sliceHunk(file, 0, 30)
  const two = sliceHunk(file, 30, 30)
  const three = sliceHunk(file, 60, 30)

  expect(one.text.split('\n')[1]).toBe('+line 1')
  expect(two.text.split('\n')[1]).toBe('+line 31')
  expect(three.last).toBe(70)
  expect(three.text).toContain('+line 70')
})

test('every page of a hunk is a hunk whose header agrees with its own body', async () => {
  const mixed = [
    '@@ -10,12 +10,13 @@ export const call = () => {',
    ...Array.from({ length: 4 }, (_, at) => ` ctx ${at}`),
    '-old one',
    '-old two',
    '+new one',
    '+new two',
    '+new three',
    ...Array.from({ length: 6 }, (_, at) => ` tail ${at}`),
  ].join('\n')

  for (const offset of [0, 3, 5, 8, 10]) {
    const page = sliceHunk(mixed, offset, 5)
    expect(agrees(page.text)).toBe(true)
    // The function context after the header survives every page.
    expect(page.text.split('\n')[0]).toContain('export const call')
  }
})

test('a later page starts at the line it shows, on both sides', async () => {
  const text = ['@@ -10,5 +10,5 @@', ' a', ' b', '-c', '+C', ' d', ' e'].join('\n')

  // Past " a", " b" and "-c": three lines of the old side, two of the new.
  const page = sliceHunk(text, 3, 3)

  expect(page.text.split('\n')[0]).toBe('@@ -13,2 +12,3 @@')
})

test('the last page is pulled back to stay full', async () => {
  const page = sliceHunk(newFile(50), 45, 30)

  expect(page.first).toBe(20)
  expect(page.last).toBe(50)
})

test('a page asked for before the start begins at the start', async () => {
  expect(sliceHunk(newFile(50), -10, 30).first).toBe(0)
})

test('a new file pages keep the old side at nothing', async () => {
  const page = sliceHunk(newFile(50), 30, 10)

  expect(page.text.split('\n')[0]).toBe('@@ -0,0 +31,10 @@')
})

test('a line takes as many rows as it needs to wrap, and never none', async () => {
  expect(rowsFor('+short', 40)).toBe(1)
  expect(rowsFor('+' + 'x'.repeat(80), 40)).toBe(2)
  expect(rowsFor('+' + 'x'.repeat(81), 40)).toBe(3)
  // The marker is drawn in the gutter, so it does not count toward the width.
  expect(rowsFor('+' + 'x'.repeat(40), 40)).toBe(1)
  expect(rowsFor('+', 40)).toBe(1)
})

test('a page of long lines holds fewer of them, so the controls stay on screen', async () => {
  const long = ['@@ -0,0 +1,6 @@', ...Array.from({ length: 6 }, () => '+' + 'y'.repeat(90))].join('\n')
  const short = ['@@ -0,0 +1,6 @@', ...Array.from({ length: 6 }, () => '+z')].join('\n')

  // Each 90-character line wraps to 3 rows at 40 columns: 9 rows hold 3 lines.
  expect(linesThatFit(long, 0, 9, 40)).toBe(3)
  expect(linesThatFit(short, 0, 9, 40)).toBe(6)
})

test('a line too long for the whole pane is still shown, alone', async () => {
  const huge = ['@@ -0,0 +1,2 @@', '+' + 'w'.repeat(500), '+next'].join('\n')

  expect(linesThatFit(huge, 0, 5, 40)).toBe(1)
})

test('the status hint says how to reach the pane, and nothing once it is in view', async () => {
  // Missing (closed, never opened, or the list could not be read) is not a
  // narrow terminal, even if some earlier open was.
  expect(paneHint(undefined)).toBe(' · open with /wait-review')
  expect(paneHint(undefined, true)).toBe(' · open with /wait-review')
  // Unplaced for some other reason: no surface, say.
  expect(paneHint({ isPlaced: false, isShown: false })).toBe(' · open with /wait-review')
  // The engine refused an unasked open for width, and the pane is still waiting.
  expect(paneHint({ isPlaced: false, isShown: false }, true)).toBe(
    ' · terminal too narrow — /wait-review opens anyway',
  )
  // Placed, but another pane's tab is in front of it.
  expect(paneHint({ isPlaced: true, isShown: false }, true)).toBe(' · open with /wait-review')
  expect(paneHint({ isPlaced: true, isShown: true }, true)).toBe('')
})

test('only the engine’s column refusal counts as a narrow terminal', async () => {
  expect(
    isNarrowPlacement(
      'unasked below 144 columns (80 now): placed when the person opens it, or when the terminal is widened to 144 columns',
    ),
  ).toBe(true)
  expect(
    isNarrowPlacement(
      'unasked below 110 columns (90 now, an id the person opened before): placed when the person opens it, or when the terminal is widened to 110 columns',
    ),
  ).toBe(true)
  expect(isNarrowPlacement('no attached surface places panes (headless)')).toBe(false)
  expect(isNarrowPlacement(undefined)).toBe(false)
})

test('the progress bar is full only when all is read, and empty only before any is', async () => {
  expect(filledCells(0, 5, 12)).toBe(0)
  expect(filledCells(5, 5, 12)).toBe(12)
  // One of many read still shows; all but one is never drawn as done.
  expect(filledCells(1, 40, 12)).toBe(1)
  expect(filledCells(39, 40, 12)).toBe(11)
  expect(filledCells(1, 2, 12)).toBe(6)
  // Nothing to read, or no room for a bar, draws none.
  expect(filledCells(0, 0, 12)).toBe(0)
  expect(filledCells(3, 5, 0)).toBe(0)
})

const stats = (over: Partial<SessionStats> = {}): SessionStats => ({ ...EMPTY_SESSION, ...over })

test('the grade is S only at 90% acted on or better, and at least one flag', async () => {
  expect(gradeOf(stats({ read: 9, skipped: 1, flagged: 1 }))).toBe('S')
  // Same percent, no flag: good calibration is not evidence of a careful read.
  expect(gradeOf(stats({ read: 9, skipped: 1, flagged: 0 }))).toBe('A')
})

test('the grade cutoffs land exactly where the percentages say', async () => {
  expect(gradeOf(stats({ read: 90, skipped: 10, flagged: 1 }))).toBe('S')
  expect(gradeOf(stats({ read: 89, skipped: 11, flagged: 1 }))).toBe('A')
  expect(gradeOf(stats({ read: 75, skipped: 25 }))).toBe('A')
  expect(gradeOf(stats({ read: 74, skipped: 26 }))).toBe('B')
  expect(gradeOf(stats({ read: 50, skipped: 50 }))).toBe('B')
  expect(gradeOf(stats({ read: 49, skipped: 51 }))).toBe('C')
})

test('nothing resolved yet grades C, not a divide by zero', async () => {
  expect(gradeOf(EMPTY_SESSION)).toBe('C')
})

test('the session summary line names every stat and the grade', async () => {
  const line = sessionSummaryLine(stats({ read: 9, skipped: 1, flagged: 1, longestCombo: 5 }))

  expect(line).toContain('9 read')
  expect(line).toContain('1 flagged')
  expect(line).toContain('1 skipped')
  expect(line).toContain('longest combo 5')
  expect(line).toContain('grade S')
})
