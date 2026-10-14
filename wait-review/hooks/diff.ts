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
    const head = HUNK_HEAD.exec(header)
    hunks.push({
      id: `${path}@${hash(text)}`,
      path,
      header,
      start: Number(head?.[3] ?? 0),
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
 * The order a person reads in: each file together, top of the file first.
 *
 * Without this the queue grows in whatever order the scans happened to find
 * things, and reading jumps between files mid-thought.
 */
export const sortHunks = (list: readonly Hunk[]): Hunk[] =>
  [...list].sort((a, b) => (a.path === b.path ? a.start - b.start : a.path < b.path ? -1 : 1))

/**
 * Merges a fresh scan into the queue, keeping what the person already decided.
 *
 * The scan reads the whole repository diff, so `found` is the whole truth: a
 * hunk missing from it was reverted or committed away and leaves the queue,
 * and one the agent rewrote returns under a new id, undecided.
 */
export const mergeHunks = (old: readonly Hunk[], found: readonly Hunk[], limit = 400): Hunk[] => {
  const decided = new Map(old.map(hunk => [hunk.id, hunk]))

  // Cap newest-first so a huge diff drops the tail rather than every file late
  // in the alphabet; order what survives for reading.
  return sortHunks(found.map(hunk => decided.get(hunk.id) ?? hunk).slice(-limit))
}

/**
 * The hunks worth offering: not in an ignored file, and not already there
 * before the session began.
 */
export const reviewable = (
  found: readonly Hunk[],
  ignore: readonly string[],
  preexisting: readonly string[],
): Hunk[] => {
  const before = new Set(preexisting)

  return found.filter(hunk => !before.has(hunk.id) && !isIgnored(hunk.path, ignore))
}

/**
 * Where the current hunk sits in what is left to read.
 *
 * A reviewer wants to know how much is still coming before they commit to
 * reading, and which file they are in; a bare count of unread hunks says
 * neither.
 */
export type Progress = {
  /** Unread hunks in this file, the current one included. */
  hereLeft: number
  /** Unread hunks in all, the current one included. */
  totalLeft: number
  /** This file's place among the files with anything left. */
  atFile: number
  ofFiles: number
}

const isLeft = (hunk: Hunk): boolean => hunk.status === 'pending' || hunk.status === 'later'

export const progressOf = (list: readonly Hunk[], current: Hunk): Progress => {
  const left = list.filter(isLeft)
  const files = [...new Set(left.map(one => one.path))]

  return {
    hereLeft: left.filter(one => one.path === current.path).length,
    totalLeft: left.length,
    atFile: files.indexOf(current.path) + 1,
    ofFiles: files.length,
  }
}

/** The counts worth showing: a zero says nothing, so it is left out. */
export const summaryOf = (list: readonly Hunk[]): string => {
  const counts = tally(list)
  const parts: string[] = []
  if (counts.pending > 0) parts.push(`${counts.pending} to read`)
  if (counts.reviewed > 0) parts.push(`${counts.reviewed} read`)
  if (counts.flagged > 0) parts.push(`${counts.flagged} flagged`)
  if (counts.later > 0) parts.push(`${counts.later} put off`)
  if (counts.dropped > 0) parts.push(`${counts.dropped} skipped`)

  return parts.join(' · ')
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
  dropped: list.filter(hunk => hunk.status === 'dropped').length,
})

/**
 * Files the agent writes but nobody reviews: lockfiles, build output,
 * snapshots. One regenerated lockfile is otherwise forty hunks of noise ahead
 * of the code that matters.
 */
export const DEFAULT_IGNORE = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/go.sum',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
].join(',')

/** Splits a configured ignore list on commas and newlines. */
export const parseIgnore = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map(one => one.trim())
    .filter(one => one !== '')

/**
 * A glob as a whole-path pattern: `*` within a segment, `?` one character,
 * `**` across segments, and a leading double-star-slash that may match no
 * leading segments at all, so one pattern covers a relative and an absolute
 * spelling of the same file.
 */
export const globToRegExp = (pattern: string): RegExp => {
  let out = ''
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]
    if (char === '*') {
      if (pattern[at + 1] === '*') {
        if (pattern[at + 2] === '/') {
          out += '(?:.*/)?'
          at += 2
        } else {
          out += '.*'
          at += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += (char ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  return new RegExp(`^${out}$`)
}

/** Whether any pattern covers this path; matched against the path as given. */
export const isIgnored = (path: string, patterns: readonly string[]): boolean =>
  patterns.some(pattern => globToRegExp(pattern).test(path))

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
    const said = hunk.note === undefined || hunk.note === '' ? '' : `\nthey said: ${hunk.note}`
    const block = `${hunk.path} ${hunk.header}${said}\n\`\`\`diff\n${hunk.text}\n\`\`\`\n`
    if (block.length > budget && shown > 0) break
    lines.push(block)
    budget -= block.length
    shown++
  }
  const left = flagged.length - shown
  if (left > 0) lines.push(`(${left} more flagged hunk${left === 1 ? '' : 's'} not shown here.)`)
  return lines.join('\n')
}
