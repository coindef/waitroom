/**
 * Pure diff handling: no engine, no $, so `claude plugin test` exercises it
 * directly.
 */

import type { Hunk } from '../types'

/** FNV-1a, in base 36. Enough to tell one hunk's text from another's. */
export const hash = (text: string): string => {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value.toString(36)
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

/** Absolute by POSIX root or by Windows drive. */
const ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/])/

/**
 * The file name off a `---` or `+++` line.
 *
 * Under `--no-prefix` git terminates the name with a tab when it holds a space,
 * as the unified diff convention requires, and quotes it when `core.quotePath`
 * is on; neither belongs in the name.
 */
export const sidePath = (rest: string): string => {
  const cut = rest.indexOf('\t')
  const name = cut < 0 ? rest : rest.slice(0, cut)

  return name.length > 1 && name.startsWith('"') && name.endsWith('"')
    ? name.slice(1, -1)
    : name
}

/**
 * The path as git names it: relative to the repository root, `/` separated.
 *
 * `Edit` and `Write` carry absolute paths while git prints relative ones, so
 * without this the two never compare equal and a rescan can neither recognise
 * a hunk it already holds nor drop one the agent reverted.
 */
export const toRepoPath = (root: string, path: string): string => {
  const slashed = path.replace(/\\/g, '/')
  if (!ABSOLUTE.test(path)) return slashed
  const base = root.replace(/\\/g, '/').replace(/\/$/, '') + '/'

  return slashed.startsWith(base) ? slashed.slice(base.length) : slashed
}

/** A body line git writes inside a hunk: context, added, removed, or the no-newline marker. */
const isBodyLine = (line: string): boolean =>
  line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')

/**
 * Reads `git diff --no-prefix` output into hunks, each one its own review card.
 *
 * Paths come off the `---` / `+++` pair rather than the `diff --git` line, whose
 * two halves cannot be split apart when a path holds a space. A side reading
 * `/dev/null` (a file added or deleted whole) falls back to the other side.
 */
export const parseDiff = (output: string): Hunk[] => {
  const hunks: Hunk[] = []
  let minus = ''
  let plus = ''
  let path = ''
  let header = ''
  let body: string[] = []
  let isOpen = false

  const flush = () => {
    if (!isOpen) return
    isOpen = false
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    if (body.length === 0) return
    const text = [header, ...body].join('\n')
    hunks.push({
      id: `${path}@${hash(text)}`,
      path,
      header,
      text,
      added: body.filter(line => line.startsWith('+')).length,
      removed: body.filter(line => line.startsWith('-')).length,
      status: 'pending',
    })
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --no-index ')) {
      flush()
      minus = ''
      plus = ''
      continue
    }
    if (line.startsWith('--- ')) {
      flush()
      minus = sidePath(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      flush()
      plus = sidePath(line.slice(4))
      path = plus !== '/dev/null' ? plus : minus
      continue
    }
    const head = HUNK_HEAD.exec(line)
    if (head) {
      flush()
      header = line
      body = []
      isOpen = path !== ''
      continue
    }
    if (isOpen && isBodyLine(line)) {
      body.push(line)
      continue
    }
    flush()
  }
  flush()

  return hunks
}

/** Counts the `-` and `+` side of a body, the way a hunk header reports them. */
const countSides = (body: readonly string[]): { removed: number; added: number } => {
  let removed = 0
  let added = 0
  for (const line of body) {
    if (line.startsWith('\\')) continue
    if (line.startsWith('-')) removed++
    else if (line.startsWith('+')) added++
    else {
      removed++
      added++
    }
  }
  return { removed, added }
}

/**
 * Cuts a hunk down to `maxLines` of body and rewrites its header's line counts
 * to match, because a hunk whose counts disagree with its body is a hunk the
 * `Code` element will not parse as a diff.
 */
export const trimHunk = (text: string, maxLines: number): { text: string; hidden: number } => {
  const lines = text.split('\n')
  const header = lines[0] ?? ''
  const body = lines.slice(1)
  if (maxLines < 1) return { text: header, hidden: body.length }
  if (body.length <= maxLines) return { text, hidden: 0 }

  const kept = body.slice(0, maxLines)
  const head = HUNK_HEAD.exec(header)
  if (!head) return { text: [header, ...kept].join('\n'), hidden: body.length - kept.length }

  const sides = countSides(kept)
  const rewritten = `@@ -${head[1]},${sides.removed} +${head[3]},${sides.added} @@${head[5] ?? ''}`
  return { text: [rewritten, ...kept].join('\n'), hidden: body.length - kept.length }
}

/**
 * Merges a fresh scan into the queue, keeping what the person already decided.
 *
 * `scanned` is every path the scan asked git about, not every path it found, so
 * a file whose changes were all reverted has its stale hunks dropped rather
 * than kept forever.
 */
export const mergeHunks = (
  old: readonly Hunk[],
  found: readonly Hunk[],
  scanned: readonly string[],
  limit = 400,
): Hunk[] => {
  const decided = new Map(old.map(hunk => [hunk.id, hunk]))
  const asked = new Set(scanned)
  const kept = old.filter(hunk => !asked.has(hunk.path))
  const merged = found.map(hunk => decided.get(hunk.id) ?? hunk)
  return [...kept, ...merged].slice(-limit)
}

/** The hunk to show: the first one not yet decided, else the first put off. */
export const nextHunk = (list: readonly Hunk[]): Hunk | undefined =>
  list.find(hunk => hunk.status === 'pending') ?? list.find(hunk => hunk.status === 'later')

/** How the queue stands, for the pane's counts and the status line. */
export const tally = (list: readonly Hunk[]) => ({
  pending: list.filter(hunk => hunk.status === 'pending').length,
  later: list.filter(hunk => hunk.status === 'later').length,
  flagged: list.filter(hunk => hunk.status === 'flagged').length,
  reviewed: list.filter(hunk => hunk.status === 'ok' || hunk.status === 'sent').length,
})

const NOTE_BUDGET = 12000

/**
 * The review notes that ride along with the next prompt: the flagged hunks, as
 * the diff the person was looking at when they flagged them.
 */
export const reviewNote = (flagged: readonly Hunk[]): string => {
  const lines: string[] = [
    'Review notes from wait-review. While you were working, the user read the',
    'diff you had already written and flagged the hunks below. Treat each one as',
    'a review comment: fix it, or say why it should stay as it is.',
    '',
  ]
  let budget = NOTE_BUDGET
  let shown = 0
  for (const hunk of flagged) {
    const block = `${hunk.path} ${hunk.header}\n\`\`\`diff\n${hunk.text}\n\`\`\`\n`
    if (block.length > budget && shown > 0) break
    lines.push(block)
    budget -= block.length
    shown++
  }
  const left = flagged.length - shown
  if (left > 0) lines.push(`(${left} more flagged hunk${left === 1 ? '' : 's'} not shown here.)`)
  return lines.join('\n')
}
