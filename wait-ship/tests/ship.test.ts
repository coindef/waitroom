import { expect, test } from 'claude-code/testing'

import {
  applyCommandFor,
  areasOf,
  BAND_PRECEDENCE,
  bodyOf,
  bulletStyleOf,
  changelogEntryOf,
  commitFileText,
  commitOf,
  DRAFTS_GITIGNORE,
  drawnBy,
  type FileChange,
  fileList,
  fingerprintOf,
  formatSize,
  inferStyle,
  isChoreFile,
  isDocFile,
  isOwnFolder,
  isTestFile,
  isUnder,
  kitOf,
  parseDiffFiles,
  parseSubjects,
  prBodyOf,
  receiptLines,
  scopeOf,
  subjectOf,
  summaryBullets,
  testPlanLines,
  truncate,
  typeOf,
  verbFor,
  yieldsBand,
} from '../hooks/ship'

const diff = (lines: readonly string[]) => lines.join('\n') + '\n'

const added = (path: string, body: readonly string[] = ['+one']) =>
  diff([`diff --git ${path} ${path}`, '--- /dev/null', `+++ ${path}`, '@@ -0,0 +1,1 @@', ...body])

const modified = (path: string, added_: readonly string[], removed: readonly string[]) =>
  diff([
    `diff --git ${path} ${path}`,
    `--- ${path}`,
    `+++ ${path}`,
    '@@ -1,1 +1,1 @@',
    ...removed.map(one => `-${one}`),
    ...added_.map(one => `+${one}`),
  ])

const deleted = (path: string) =>
  diff([`diff --git ${path} ${path}`, `--- ${path}`, '+++ /dev/null', '@@ -1,1 +0,0 @@', '-gone'])

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

test('a new file parses as added, with its added lines counted', () => {
  const files = parseDiffFiles(added('src/feature.ts'))
  expect(files).toEqual([{ path: 'src/feature.ts', added: 1, removed: 0, kind: 'added' }])
})

test('a modified file parses as modified, with both sides counted', () => {
  const files = parseDiffFiles(modified('src/retry.ts', ['+a', '+b'], ['-x']))
  expect(files).toEqual([{ path: 'src/retry.ts', added: 2, removed: 1, kind: 'modified' }])
})

test('a deleted file parses as deleted', () => {
  const files = parseDiffFiles(deleted('src/old.ts'))
  expect(files).toEqual([{ path: 'src/old.ts', added: 0, removed: 1, kind: 'deleted' }])
})

test('a binary file with no --- / +++ lines is still counted', () => {
  const text = diff(['diff --git image.png image.png', 'Binary files /dev/null and image.png differ'])
  expect(parseDiffFiles(text)).toEqual([{ path: 'image.png', added: 0, removed: 0, kind: 'added' }])
})

test('several diffs concatenated parse as one combined list', () => {
  const combined = added('src/a.ts') + modified('src/b.ts', ['+y'], ['-x'])
  const files = parseDiffFiles(combined)
  expect(files.map(one => one.path)).toEqual(['src/a.ts', 'src/b.ts'])
})

test('subjects parse one per line, blanks dropped', () => {
  expect(parseSubjects('Add retry\n\nFix typo\n')).toEqual(['Add retry', 'Fix typo'])
})

// ---------------------------------------------------------------------------
// Style inference, from fixture histories
// ---------------------------------------------------------------------------

test('a history of conventional commits is read as conventional', () => {
  const style = inferStyle(['feat(ship): add drafting', 'fix(review): guard empty diff', 'chore: bump deps'])
  expect(style.kind).toBe('conventional')
})

test('a history of capitalized, imperative subjects is read as freeform, capitalized, imperative', () => {
  const style = inferStyle(['Add retry logic', 'Fix the timeout bug', 'Guard against empty input'])
  expect(style).toEqual({ kind: 'freeform', capitalized: true, tense: 'imperative' })
})

test('a history of past-tense subjects is read as past tense', () => {
  const style = inferStyle(['Added retry logic', 'Fixed the timeout bug', 'Guarded against empty input'])
  expect(style.tense).toBe('past')
})

test('a history of lowercase subjects is read as not capitalized', () => {
  const style = inferStyle(['add retry logic', 'fix the timeout bug', 'tidy the imports'])
  expect(style.capitalized).toBe(false)
})

test('an empty history falls back to capitalized, imperative, freeform', () => {
  expect(inferStyle([])).toEqual({ kind: 'freeform', capitalized: true, tense: 'imperative' })
})

test('a mixed history is judged by which side the majority falls on', () => {
  // Three conventional, two not: over half, so conventional wins.
  const style = inferStyle(['feat: a', 'fix: b', 'chore: c', 'Tidy things up', 'Add a helper'])
  expect(style.kind).toBe('conventional')
})

// ---------------------------------------------------------------------------
// Type, scope and area
// ---------------------------------------------------------------------------

test('file-path classifiers', () => {
  expect(isTestFile('src/retry.test.ts')).toBe(true)
  expect(isTestFile('tests/flow.test.tsx')).toBe(true)
  expect(isTestFile('src/retry.ts')).toBe(false)
  expect(isDocFile('README.md')).toBe(true)
  expect(isDocFile('docs/guide.md')).toBe(true)
  expect(isDocFile('src/retry.ts')).toBe(false)
  expect(isChoreFile('package-lock.json')).toBe(true)
  expect(isChoreFile('tsconfig.json')).toBe(true)
  expect(isChoreFile('src/retry.ts')).toBe(false)
})

const FEATURE: FileChange = { path: 'src/feature.ts', added: 10, removed: 0, kind: 'added' }
const TWEAK: FileChange = { path: 'src/client.ts', added: 2, removed: 1, kind: 'modified' }
const TEST: FileChange = { path: 'src/client.test.ts', added: 5, removed: 0, kind: 'added' }
const DOC: FileChange = { path: 'README.md', added: 3, removed: 1, kind: 'modified' }
const LOCK: FileChange = { path: 'package-lock.json', added: 1, removed: 1, kind: 'modified' }

test('typeOf: an all-new file is a feature', () => {
  expect(typeOf([FEATURE])).toBe('feat')
})

test('typeOf: an all-test diff is test', () => {
  expect(typeOf([TEST])).toBe('test')
})

test('typeOf: an all-doc diff is docs', () => {
  expect(typeOf([DOC])).toBe('docs')
})

test('typeOf: an all-lockfile diff is chore', () => {
  expect(typeOf([LOCK])).toBe('chore')
})

test('typeOf: a plain modification with more removed than added reads as refactor', () => {
  const trimmed: FileChange = { path: 'src/client.ts', added: 1, removed: 5, kind: 'modified' }
  expect(typeOf([trimmed])).toBe('refactor')
})

test('typeOf: a plain modification otherwise reads as fix', () => {
  expect(typeOf([TWEAK])).toBe('fix')
})

test('typeOf: no files is chore, never a crash', () => {
  expect(typeOf([])).toBe('chore')
})

test('areasOf groups by top-level folder, and "." for one with none', () => {
  const areas = areasOf([FEATURE, TWEAK, { path: 'README.md', added: 1, removed: 0, kind: 'modified' }])
  expect([...areas.keys()]).toEqual(['src', '.'])
})

test('scopeOf names the one shared area, or nothing across several, or nothing at the root', () => {
  expect(scopeOf([FEATURE, TWEAK])).toBe('src')
  expect(scopeOf([FEATURE, DOC])).toBeUndefined()
  expect(scopeOf([DOC])).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test('verbFor reads the majority action', () => {
  expect(verbFor([FEATURE, FEATURE, TWEAK])).toBe('add')
  expect(verbFor([TWEAK, TWEAK])).toBe('update')
  expect(verbFor([{ path: 'a', added: 0, removed: 1, kind: 'deleted' }])).toBe('remove')
})

test('truncate leaves a short subject alone and cuts a long one to fit, with an ellipsis', () => {
  expect(truncate('short', 72)).toBe('short')
  const long = 'a'.repeat(100)
  const cut = truncate(long, 72)
  expect(cut.length).toBe(72)
  expect(cut.endsWith('…')).toBe(true)
})

test('fileList names up to five files, and counts the rest past that', () => {
  const five = Array.from({ length: 5 }, (_, at) => ({ path: `f${at}.ts`, added: 1, removed: 0, kind: 'added' as const }))
  expect(fileList(five)).toBe('f0.ts, f1.ts, f2.ts, f3.ts, f4.ts')
  const six = [...five, { path: 'f5.ts', added: 1, removed: 0, kind: 'added' as const }]
  expect(fileList(six)).toBe('f0.ts, f1.ts, f2.ts, f3.ts, f4.ts +1 more')
})

test('subjectOf: a single file is named outright, under the 72-character cap', () => {
  const style = inferStyle(['feat: a', 'fix: b', 'chore: c'])
  const subject = subjectOf([FEATURE], style, 'feat', 'src')
  expect(subject).toBe('feat(src): add src/feature.ts')
  expect(subject.length).toBeLessThanOrEqual(72)
})

test('subjectOf: freeform style matches capitalization and tense', () => {
  const imperative = inferStyle(['Add a thing', 'Fix a thing'])
  expect(subjectOf([FEATURE], imperative, 'feat', undefined)).toBe('Add src/feature.ts')
  const past = inferStyle(['Added a thing', 'Fixed a thing'])
  expect(subjectOf([FEATURE], past, 'feat', undefined)).toBe('Added src/feature.ts')
})

test('bodyOf groups by area once the diff spans more than one', () => {
  const lines = bodyOf([FEATURE, TWEAK, DOC])
  expect(lines.some(line => line.startsWith('- src:'))).toBe(true)
  expect(lines.some(line => line.startsWith('- .:'))).toBe(true)
})

test('bodyOf lists one bullet per file within a single area', () => {
  const lines = bodyOf([FEATURE, TWEAK])
  expect(lines).toEqual(['- add src/feature.ts', '- update src/client.ts'])
})

test('commitOf and commitFileText produce a usable -F file', () => {
  const commit = commitOf([FEATURE], ['feat: a', 'fix: b'])
  const text = commitFileText(commit)
  expect(text.startsWith(commit.subject)).toBe(true)
  expect(text).toContain('\n\n')
})

// ---------------------------------------------------------------------------
// PR body and test plan
// ---------------------------------------------------------------------------

test('summaryBullets stays within 2-4 for a multi-area diff', () => {
  const bullets = summaryBullets([FEATURE, TWEAK, DOC])
  expect(bullets.length).toBeGreaterThanOrEqual(2)
  expect(bullets.length).toBeLessThanOrEqual(4)
})

test('summaryBullets: each area reads its own change kind, not the whole diff\'s', () => {
  const addedArea: FileChange = { path: 'added/new.ts', added: 5, removed: 0, kind: 'added' }
  const fixedArea: FileChange = { path: 'fixed/client.ts', added: 3, removed: 1, kind: 'modified' }
  const removedArea: FileChange = { path: 'removed/old.ts', added: 0, removed: 4, kind: 'deleted' }

  // The whole diff has a new file in it, so read as one lump it would say
  // "feat" for everything — the bug this guards against.
  expect(typeOf([addedArea, fixedArea, removedArea])).toBe('feat')

  const bullets = summaryBullets([addedArea, fixedArea, removedArea])
  expect(bullets.some(line => line.startsWith('- Adds new functionality in added'))).toBe(true)
  expect(bullets.some(line => line.startsWith('- Fixes behavior in fixed'))).toBe(true)
  expect(bullets.some(line => line.startsWith('- Restructures code in removed'))).toBe(true)
})

test('testPlanLines turns each touched test file into its own checkbox, plus a manual line always', () => {
  const lines = testPlanLines([TEST, FEATURE])
  expect(lines).toContain('- [ ] `src/client.test.ts` passes')
  expect(lines.at(-1)).toBe('- [ ] Manually verify the change in context')
})

test('testPlanLines keeps the manual line even with no tests touched', () => {
  expect(testPlanLines([FEATURE])).toEqual(['- [ ] Manually verify the change in context'])
})

test('prBodyOf has all three required sections in order', () => {
  const body = prBodyOf([FEATURE, TEST])
  const summaryAt = body.indexOf('## Summary')
  const changesAt = body.indexOf('## Changes')
  const planAt = body.indexOf('## Test plan')
  expect(summaryAt).toBeGreaterThanOrEqual(0)
  expect(changesAt).toBeGreaterThan(summaryAt)
  expect(planAt).toBeGreaterThan(changesAt)
})

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

test('bulletStyleOf reads a bold lead-in style from the file, or plain otherwise', () => {
  expect(bulletStyleOf('- **A thing.** Detail.\n')).toBe('bold-lead-in')
  expect(bulletStyleOf('- A thing.\n')).toBe('plain')
})

test('changelogEntryOf headings follow each area\'s own kind: feat Added, fix Fixed, else Changed', () => {
  expect(changelogEntryOf([FEATURE], 'plain')).toContain('### Added')
  expect(changelogEntryOf([TWEAK], 'plain')).toContain('### Fixed')
  expect(changelogEntryOf([DOC], 'plain')).toContain('### Changed')
})

test('changelogEntryOf matches the bold-lead-in style when the file uses it', () => {
  const entry = changelogEntryOf([FEATURE], 'bold-lead-in')
  expect(entry).toMatch(/^### Added\n- \*\*/)
})

test('changelogEntryOf: areas of different kinds land under their own heading, not the whole diff\'s', () => {
  const addedArea: FileChange = { path: 'added/new.ts', added: 5, removed: 0, kind: 'added' }
  const fixedArea: FileChange = { path: 'fixed/client.ts', added: 3, removed: 1, kind: 'modified' }

  const entry = changelogEntryOf([addedArea, fixedArea], 'plain')
  const sections = entry.trim().split('\n\n')
  const addedSection = sections.find(one => one.startsWith('### Added'))
  const fixedSection = sections.find(one => one.startsWith('### Fixed'))

  expect(addedSection).toContain('added/new.ts')
  expect(fixedSection).toContain('fixed/client.ts')
  expect(addedSection).not.toContain('fixed/client.ts')
  expect(fixedSection).not.toContain('added/new.ts')
})

// ---------------------------------------------------------------------------
// The whole kit
// ---------------------------------------------------------------------------

test('kitOf omits the changelog entry when there is no changelog content', () => {
  const kit = kitOf([FEATURE], [], undefined)
  expect(kit.changelogEntry).toBeUndefined()
})

test('kitOf includes a changelog entry when content is given', () => {
  const kit = kitOf([FEATURE], [], '- A past entry.\n')
  expect(kit.changelogEntry).toBeDefined()
})

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

test('formatSize reads small text in bytes and larger text in kilobytes', () => {
  expect(formatSize(412)).toBe('412B')
  expect(formatSize(1100)).toBe('1.1KB')
  expect(formatSize(12000)).toBe('12KB')
})

test('applyCommandFor names the right command per artifact, and never one that runs it', () => {
  expect(applyCommandFor('commit', '.waitroom/ship/COMMIT_EDITMSG.txt')).toBe(
    'git commit -F .waitroom/ship/COMMIT_EDITMSG.txt',
  )
  expect(applyCommandFor('pr', '.waitroom/ship/PR_BODY.md')).toContain('gh pr create')
  expect(applyCommandFor('changelog', '.waitroom/ship/CHANGELOG_ENTRY.md')).toContain('paste')
})

test('receiptLines names each draft written and the command that uses it, one line apiece', () => {
  expect(
    receiptLines([
      { kind: 'commit', path: '.waitroom/ship/COMMIT_EDITMSG.txt' },
      { kind: 'pr', path: '.waitroom/ship/PR_BODY.md' },
    ]),
  ).toEqual([
    'Draft written: .waitroom/ship/COMMIT_EDITMSG.txt — git commit -F .waitroom/ship/COMMIT_EDITMSG.txt',
    'Draft written: .waitroom/ship/PR_BODY.md — gh pr create --body-file .waitroom/ship/PR_BODY.md',
  ])
  expect(receiptLines([])).toEqual([])
})

// ---------------------------------------------------------------------------
// The row above the prompt
// ---------------------------------------------------------------------------

test('the row goes to breathe first, then ship, then bet: one mod at a time', () => {
  expect(BAND_PRECEDENCE).toEqual(['wait-breathe', 'wait-ship', 'bet-on-your-agent'])
  // A breathe nudge beneath keeps the row ahead of a kit...
  expect(yieldsBand('wait-ship', 'wait-breathe')).toBe(true)
  // ...a bet question beneath gives it up to one...
  expect(yieldsBand('wait-ship', 'bet-on-your-agent')).toBe(false)
  // ...and the same holds across the other pairs, whichever mod asks.
  expect(yieldsBand('bet-on-your-agent', 'wait-breathe')).toBe(true)
  expect(yieldsBand('bet-on-your-agent', 'wait-ship')).toBe(true)
  expect(yieldsBand('wait-breathe', 'wait-ship')).toBe(false)
  expect(yieldsBand('wait-breathe', 'bet-on-your-agent')).toBe(false)
})

test('a row from nobody in particular, or from outside waitroom, never outranks a waitroom mod', () => {
  expect(yieldsBand('bet-on-your-agent', undefined)).toBe(false)
  expect(yieldsBand('bet-on-your-agent', 'engine')).toBe(false)
  expect(yieldsBand('bet-on-your-agent', 'some-other-plugin')).toBe(false)
  // Its own row beneath (a second load of the same mod) is no reason to yield either.
  expect(yieldsBand('wait-ship', 'wait-ship')).toBe(false)
})

test('drawnBy reads the plugin the engine stamped on a tree, and nothing off anything else', () => {
  expect(drawnBy({ type: 'Box', part: { plugin: 'wait-breathe' } })).toBe('wait-breathe')
  expect(drawnBy({ type: 'Box' })).toBeUndefined()
  expect(drawnBy({ type: 'Box', part: { plugin: 7 } })).toBeUndefined()
  expect(drawnBy(undefined)).toBeUndefined()
  expect(drawnBy('text')).toBeUndefined()
})

// ---------------------------------------------------------------------------
// The drafts folder and the tree between turns
// ---------------------------------------------------------------------------

test('isUnder places a path inside the drafts folder however the folder is written', () => {
  expect(isUnder('.waitroom/ship/PR_BODY.md', '.waitroom/ship')).toBe(true)
  expect(isUnder('.waitroom/ship/PR_BODY.md', './.waitroom/ship/')).toBe(true)
  expect(isUnder('.waitroom/ship', '.waitroom/ship')).toBe(true)
  // A sibling sharing the prefix is not inside it.
  expect(isUnder('.waitroom/shipping.md', '.waitroom/ship')).toBe(false)
  expect(isUnder('src/feature.ts', '.waitroom/ship')).toBe(false)
  // The root holds everything, so it is never treated as the drafts folder.
  expect(isUnder('src/feature.ts', '.')).toBe(false)
})

test('only a folder of its own gets the drafts .gitignore: never the root, an absolute path, or a step outside', () => {
  expect(DRAFTS_GITIGNORE).toBe('*\n')
  expect(isOwnFolder('.waitroom/ship')).toBe(true)
  expect(isOwnFolder('./drafts')).toBe(true)
  expect(isOwnFolder('.')).toBe(false)
  expect(isOwnFolder('./')).toBe(false)
  expect(isOwnFolder('')).toBe(false)
  expect(isOwnFolder('/tmp/drafts')).toBe(false)
  expect(isOwnFolder('../drafts')).toBe(false)
  expect(isOwnFolder('drafts/../..')).toBe(false)
})

test('the same changes read the same fingerprint, and any change reads another', () => {
  const tree = added('src/feature.ts')
  expect(fingerprintOf(tree)).toBe(fingerprintOf(`${tree}`))
  expect(fingerprintOf(tree)).not.toBe(fingerprintOf(added('src/feature.ts', ['+two'])))
  expect(fingerprintOf('')).not.toBe(fingerprintOf(tree))
})
