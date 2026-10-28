import { expect, test } from 'claude-code/testing'

import {
  BAND_PRECEDENCE,
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  enabledRowKey,
  hintOf,
  MAX_ROWS,
  overflowLine,
  parseDiffFiles,
  SUBTITLE,
  summaryFor,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  UNAVAILABLE_TIP,
  yieldsBand,
} from '../hooks/changed'
import type { FileStat, TreeScan } from '../types'

const diff = (lines: readonly string[]) => lines.join('\n') + '\n'

const added = (path: string, body: readonly string[] = ['+one']) =>
  diff([`diff --git ${path} ${path}`, '--- /dev/null', `+++ ${path}`, '@@ -0,0 +1,1 @@', ...body])

const modified = (path: string, plus: readonly string[], minus: readonly string[]) =>
  diff([
    `diff --git ${path} ${path}`,
    `--- ${path}`,
    `+++ ${path}`,
    '@@ -1,1 +1,1 @@',
    ...minus.map(one => `-${one}`),
    ...plus.map(one => `+${one}`),
  ])

const deleted = (path: string) =>
  diff([`diff --git ${path} ${path}`, `--- ${path}`, '+++ /dev/null', '@@ -1,1 +0,0 @@', '-gone'])

const scan = (files: readonly FileStat[]): TreeScan => ({ ok: true, files })

const failed: TreeScan = { ok: false }

test('the card copy is the spec copy, and nothing longer', () => {
  expect(TITLE).toBe('这回合改了啥')
  expect(SUBTITLE).toBe('只读本地 git，未上传')
  expect(DISMISS_LABEL).toBe('关闭')
  expect(DISABLE_LABEL).toBe('不再显示')
  expect(overflowLine(3)).toBe('还有 3 个文件…')
  expect(UNAVAILABLE_TIP).toBe('读不到本地改动（不是 git 仓库？）— 仍可关')
  expect(MAX_ROWS).toBe(8)
})

test('a new file parses as added, with its added lines counted', () => {
  const files = parseDiffFiles(added('src/feature.ts', ['+export const x = 1']))

  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ path: 'src/feature.ts', added: 1, removed: 0, kind: 'added' })
})

test('a modified file parses as modified, with both sides counted', () => {
  const files = parseDiffFiles(modified('src/retry.ts', ['+a', '+b'], ['-x']))

  expect(files[0]).toMatchObject({ path: 'src/retry.ts', added: 2, removed: 1, kind: 'modified' })
})

test('a deleted file parses as deleted', () => {
  const files = parseDiffFiles(deleted('src/old.ts'))

  expect(files[0]).toMatchObject({ path: 'src/old.ts', added: 0, removed: 1, kind: 'deleted' })
})

test('a path with a space keeps the name and drops the tab git terminates it with', () => {
  const files = parseDiffFiles(
    diff(['diff --git x x', '--- my file.ts\t', '+++ my file.ts\t', '@@ -1 +1 @@', '-a', '+b']),
  )

  expect(files[0]?.path).toBe('my file.ts')
})

test('a binary file with no --- / +++ lines is still counted', () => {
  const files = parseDiffFiles(diff(['diff --git image.png image.png', 'Binary files /dev/null and image.png differ']))

  expect(files[0]).toMatchObject({ path: 'image.png', added: 0, removed: 0, kind: 'added' })
  expect(hintOf(files[0] as FileStat)).toBe('added')
})

test('a line hint is +N −M, and a zero-count change is a single word', () => {
  expect(hintOf({ added: 12, removed: 3, kind: 'modified' })).toBe('+12 −3')
  expect(hintOf({ added: 0, removed: 0, kind: 'modified' })).toBe('modified')
  expect(hintOf({ added: 0, removed: 0, kind: 'deleted' })).toBe('deleted')
})

test('no diff, a failed scan, and a missing baseline are all silent', () => {
  const dirty = scan(parseDiffFiles(added('src/a.ts')))

  expect(summaryFor(scan([]), scan([]))).toBeNull()
  expect(summaryFor(dirty, dirty)).toBeNull()
  expect(summaryFor(failed, dirty)).toBeNull()
  expect(summaryFor(dirty, failed)).toBeNull()
  expect(summaryFor(null, dirty)).toBeNull()
  expect(summaryFor(scan([]), null)).toBeNull()
})

test('a file that was already dirty is not this turn; a new file is, with its own counts', () => {
  const before = scan(parseDiffFiles(modified('src/old.ts', ['+keep'], ['-drop'])))
  const after = scan(parseDiffFiles(modified('src/old.ts', ['+keep'], ['-drop']) + added('src/new.ts', ['+a', '+b'])))
  const summary = summaryFor(before, after)

  expect(summary).toEqual({ rows: [{ path: 'src/new.ts', hint: '+2 −0' }], overflow: 0 })
})

test('lines added on top of a dirty file are the delta, not the whole file', () => {
  const before = scan(parseDiffFiles(modified('src/retry.ts', ['+a'], ['-x'])))
  const after = scan(parseDiffFiles(modified('src/retry.ts', ['+a', '+b', '+c'], ['-x', '-y'])))
  const summary = summaryFor(before, after)

  expect(summary?.rows).toEqual([{ path: 'src/retry.ts', hint: '+2 −1' }])
})

test('a rewrite that keeps the counts reads as modified, not as a zero delta', () => {
  const before = scan(parseDiffFiles(modified('src/retry.ts', ['+before'], ['-old'])))
  const after = scan(parseDiffFiles(modified('src/retry.ts', ['+after'], ['-old'])))
  const summary = summaryFor(before, after)

  expect(summary?.rows).toEqual([{ path: 'src/retry.ts', hint: 'modified' }])
})

test('an untracked file that disappeared reads as deleted; a reverted tracked edit reads as modified', () => {
  const before = scan(parseDiffFiles(added('src/new.ts') + modified('src/old.ts', ['+a'], ['-b'])))
  const summary = summaryFor(before, scan([]))

  expect(summary?.rows).toEqual([
    { path: 'src/new.ts', hint: 'deleted' },
    { path: 'src/old.ts', hint: 'modified' },
  ])
})

test('nine files show eight rows and one overflow line, and eight show no overflow', () => {
  const many = (count: number) =>
    scan(parseDiffFiles(Array.from({ length: count }, (_, at) => added(`src/f${at}.ts`)).join('')))
  const nine = summaryFor(scan([]), many(9))
  const eight = summaryFor(scan([]), many(8))

  expect(nine?.rows).toHaveLength(8)
  expect(nine?.rows.map(row => row.path)).not.toContain('src/f8.ts')
  expect(nine?.overflow).toBe(1)
  expect(overflowLine(nine?.overflow ?? 0)).toBe('还有 1 个文件…')
  expect(eight?.rows).toHaveLength(8)
  expect(eight?.overflow).toBe(0)
})

test('the command lines do not lead with the plugin name, or offer a write or a network', () => {
  for (const line of [turnedOnLine(), turnedOffLine(), turnedOffLocallyLine('locked'), toggleRefusedLine('locked')]) {
    // The engine prints `wait-changed:` in front. The settings path may name it; the line must not.
    expect(line).not.toMatch(/^wait-changed\b/)
    expect(line).not.toMatch(/\b(commit|push|pull|upload|https?)\b/i)
  }
  expect(turnedOnLine()).toMatch(/^on · /)
  expect(turnedOnLine()).toContain('/wait-changed turns it off')
  expect(turnedOffLine()).toMatch(/^off · /)
  expect(turnedOffLine()).toContain('/wait-changed turns it back on')
  expect(turnedOffLine()).toContain('/plugin → wait-changed → Show a turn-end diff card')
  expect(turnedOffLocallyLine('a managed setting owns it')).toContain('kept off on this machine')
  expect(toggleRefusedLine('a managed setting owns it')).toMatch(/^still off · /)
})

test('the enabled row is found under the installed name or a working copy\'s, and nothing else', () => {
  expect(enabledRowKey([{ key: 'theme' }, { key: 'wait-changed.enabled' }])).toBe('wait-changed.enabled')
  expect(enabledRowKey([{ key: 'wait-changed@inline.enabled' }])).toBe('wait-changed@inline.enabled')
  expect(enabledRowKey([{ key: 'wait-changed.other' }, { key: 'wait-changed-x.enabled' }])).toBe('wait-changed.enabled')
  expect(enabledRowKey([])).toBe('wait-changed.enabled')
})

test('the row goes to breathe, then this card, then ship, then the bet', () => {
  expect(BAND_PRECEDENCE).toEqual(['wait-breathe', 'wait-changed', 'wait-ship', 'bet-on-your-agent'])
  expect(yieldsBand('wait-changed', 'wait-breathe')).toBe(true)
  expect(yieldsBand('wait-changed', 'wait-ship')).toBe(false)
  expect(yieldsBand('wait-changed', 'bet-on-your-agent')).toBe(false)
  expect(yieldsBand('wait-ship', 'wait-changed')).toBe(true)
  expect(yieldsBand('bet-on-your-agent', 'wait-changed')).toBe(true)
  expect(yieldsBand('wait-changed', undefined)).toBe(false)
  expect(drawnBy({ type: 'Box', part: { plugin: 'wait-breathe' } })).toBe('wait-breathe')
  expect(drawnBy({ type: 'Box' })).toBeUndefined()
})
