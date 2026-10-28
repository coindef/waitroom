/**
 * Pure turn-diff logic: no engine, no $, so `claude plugin test` exercises it
 * directly. Read-only by construction — it names files and counts lines, and
 * it never writes a path, a commit, or a network call.
 */

import type { FileKind, FileStat, TreeScan } from '../types'

/** Glance cap: past this, one overflow line instead of another file row. */
export const MAX_ROWS = 8

/** Card copy, locked to the UX spec. The title is the whole title — no tag beside it. */
export const TITLE = '这回合改了啥'
export const SUBTITLE = '只读本地 git，未上传'
export const DISMISS_LABEL = '关闭'
export const DISABLE_LABEL = '不再显示'

/**
 * The only sentence a non-git or failed diff is allowed to say.
 *
 * v1 does not say it. A failed read stays silent, which is what the spec
 * prefers; the sentence is fixed here so a later tip cannot drift from it.
 */
export const UNAVAILABLE_TIP = '读不到本地改动（不是 git 仓库？）— 仍可关'

const MINUS = '−'

/** `还有 N 个文件…`, with the spec's ellipsis. */
export const overflowLine = (count: number): string => `还有 ${count} 个文件…`

/**
 * The `/config` row this plugin's `enabled` field answers to: a row's key is
 * `<plugin>.<field>`, and a working copy loaded with `--plugin-dir` may carry
 * a suffix on its name (`wait-changed@inline`).
 */
export const ENABLED_ROW = /^wait-changed(@[\w-]+)?\.enabled$/

/** The key `$.config.set` takes for `enabled`, read off the rows `$.config.list()` returns. */
export const enabledRowKey = (rows: readonly { key: string }[]): string =>
  rows.find(row => ENABLED_ROW.test(row.key))?.key ?? 'wait-changed.enabled'

/**
 * What `/wait-changed` answers once it has flipped the setting on.
 *
 * The engine prints it as `wait-changed: on · …`, so the line does not name
 * the plugin again, and it names the one command that turns it back off.
 */
export const turnedOnLine = (): string =>
  'on · a read-only file list once a turn changes files · /wait-changed turns it off'

/** What `/wait-changed` answers once the setting is off, and the two places that turn it back on. */
export const turnedOffLine = (): string =>
  'off · /wait-changed turns it back on · /plugin → wait-changed → Show a turn-end diff card'

/**
 * The setting could not be written, but the card is still off on this machine.
 *
 * `/wait-changed` is the way back on: the settings screen may still read as
 * on, because that write did not land.
 */
export const turnedOffLocallyLine = (reason: string): string =>
  `off · the setting did not change (${reason}) · kept off on this machine · /wait-changed turns it back on`

/** What `/wait-changed` answers when a turn-on was refused: nothing moved. */
export const toggleRefusedLine = (reason: string): string =>
  `still off · the setting did not change (${reason}) · /plugin → wait-changed → Show a turn-end diff card`

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * The file name off a `---` or `+++` line, the way `git diff --no-prefix`
 * writes it: tab-terminated when it holds a space, quoted under
 * `core.quotePath`. Neither belongs in the name.
 */
export const sidePath = (rest: string): string => {
  const cut = rest.indexOf('\t')
  const name = cut < 0 ? rest : rest.slice(0, cut)

  return name.length > 1 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name
}

const BINARY_LINE = /^Binary files (.+) and (.+) differ$/

/** FNV-1a, base 36. Enough to tell one file's changed lines from another's. */
const digestOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(36)
}

/**
 * Reads `git diff --no-color --no-prefix` output (one or several, concatenated)
 * into a file list: which files, how many lines each way, and whether a file
 * is new, gone, or just different.
 */
export const parseDiffFiles = (output: string): FileStat[] => {
  const files: FileStat[] = []
  let minus = ''
  let plus = ''
  let added = 0
  let removed = 0
  let body = ''
  let hasHeader = false

  const flush = () => {
    if (!hasHeader) return
    const isNew = minus === '/dev/null'
    const isDeleted = plus === '/dev/null'
    const kind: FileKind = isNew ? 'added' : isDeleted ? 'deleted' : 'modified'
    files.push({
      path: isDeleted ? minus : plus,
      added,
      removed,
      kind,
      digest: digestOf(body),
    })
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --no-index ')) {
      flush()
      minus = ''
      plus = ''
      added = 0
      removed = 0
      body = ''
      hasHeader = false
      continue
    }
    const binary = BINARY_LINE.exec(line)
    if (binary) {
      flush()
      const [, left, right] = binary as unknown as [string, string, string]
      const kind: FileKind = left === '/dev/null' ? 'added' : right === '/dev/null' ? 'deleted' : 'modified'
      files.push({
        path: right === '/dev/null' ? left : right,
        added: 0,
        removed: 0,
        kind,
        digest: digestOf(line),
      })
      hasHeader = false
      continue
    }
    if (line.startsWith('--- ')) {
      minus = sidePath(line.slice(4))
      hasHeader = true
      continue
    }
    if (line.startsWith('+++ ')) {
      plus = sidePath(line.slice(4))
      hasHeader = true
      continue
    }
    if (line.startsWith('+')) {
      added++
      body += line
      body += '\n'
      continue
    }
    if (line.startsWith('-')) {
      removed++
      body += line
      body += '\n'
    }
  }
  flush()

  return files
}

// ---------------------------------------------------------------------------
// This turn, against the tree the turn started from
// ---------------------------------------------------------------------------

/**
 * The short hint for one file: `+12 −3` when the line counts say something,
 * otherwise a single word (`added`, `deleted`, or `modified`).
 */
export const hintOf = (file: Pick<FileStat, 'added' | 'removed' | 'kind'>): string => {
  if (file.added === 0 && file.removed === 0) {
    if (file.kind === 'added') return 'added'
    if (file.kind === 'deleted') return 'deleted'

    return 'modified'
  }

  return `+${file.added} ${MINUS}${file.removed}`
}

const sameFile = (left: FileStat, right: FileStat): boolean =>
  left.kind === right.kind && left.added === right.added && left.removed === right.removed && left.digest === right.digest

/**
 * What this turn did to one file that was already dirty, as a stat the hint
 * can read.
 *
 * A clean non-negative delta is the turn's own lines (`+2 −1`). A rewrite
 * that keeps the counts, or shrinks them, has no honest delta, so it is
 * `modified` rather than a negative number. A brand-new untracked file that
 * disappeared was deleted; a tracked edit that disappeared was reverted to
 * HEAD, which reads as `modified` — the file is not necessarily gone.
 */
const deltaStat = (was: FileStat, now: FileStat): FileStat => {
  const added = now.added - was.added
  const removed = now.removed - was.removed
  if (added >= 0 && removed >= 0 && (added > 0 || removed > 0)) {
    return { path: now.path, added, removed, kind: 'modified', digest: now.digest }
  }
  if (added === 0 && removed === 0 && was.kind !== 'added' && now.kind === 'deleted') {
    return { path: now.path, added: 0, removed: 0, kind: 'deleted', digest: now.digest }
  }

  return { path: now.path, added: 0, removed: 0, kind: 'modified', digest: now.digest }
}

/** Files whose diff moved between the two scans, in the order the later scan listed them. */
export const turnFiles = (before: readonly FileStat[], after: readonly FileStat[]): FileStat[] => {
  const prior = new Map(before.map(file => [file.path, file]))
  const still = new Set(after.map(file => file.path))
  const changed: FileStat[] = []

  for (const file of after) {
    const was = prior.get(file.path)
    if (was === undefined) changed.push(file)
    else if (!sameFile(was, file)) changed.push(deltaStat(was, file))
  }
  for (const file of before) {
    if (still.has(file.path)) continue
    // An untracked file that is gone was deleted. A tracked edit that left
    // the diff was reverted; the file itself is still there.
    changed.push({
      path: file.path,
      added: 0,
      removed: 0,
      kind: file.kind === 'added' ? 'deleted' : 'modified',
      digest: 'gone',
    })
  }

  return changed
}

export type Summary = {
  rows: { path: string; hint: string }[]
  overflow: number
}

/**
 * The card for one turn, or null when there is nothing to show.
 *
 * A missing baseline, a failed scan, and a clean delta are the same answer:
 * no card. The unavailable tip is not returned from here.
 */
export const summaryFor = (before: TreeScan | null, after: TreeScan | null): Summary | null => {
  if (before === null || after === null || !before.ok || !after.ok) return null
  const files = turnFiles(before.files, after.files)
  if (files.length === 0) return null
  const shown = files.slice(0, MAX_ROWS)

  return {
    rows: shown.map(file => ({ path: file.path, hint: hintOf(file) })),
    overflow: files.length - shown.length,
  }
}

// ---------------------------------------------------------------------------
// The row above the prompt
// ---------------------------------------------------------------------------

/**
 * The waitroom mods that draw into the row above the prompt, the one with
 * precedence first.
 *
 * Kept in lockstep with the same list in `wait-ship` and `bet-on-your-agent`:
 * hooks of different plugins nest in an order the person's installs decide,
 * so each mod draws only after asking what is already beneath it and hands
 * the row to a mod ahead of it here.
 *
 * wait-changed sits behind a breathe nudge (which is only up while a turn
 * runs, when this card is not) and ahead of a ship offer and the bet's
 * question, both of which belong to the same between-turns moment. Dismissing
 * the card is what gives them the row.
 */
export const BAND_PRECEDENCE = ['wait-breathe', 'wait-changed', 'wait-ship', 'bet-on-your-agent'] as const

export type BandMod = (typeof BAND_PRECEDENCE)[number]

/**
 * The plugin whose hook drew a band tree: the engine stamps each hook's
 * returned root with it (`part`), and a hook that passes a tree on leaves
 * the stamp as it was.
 */
export const drawnBy = (tree: unknown): string | undefined => {
  const part = typeof tree === 'object' && tree !== null ? (tree as { part?: { plugin?: unknown } }).part : undefined

  return typeof part?.plugin === 'string' ? part.plugin : undefined
}

/** Whether the row a mod drew beneath `mine` keeps the band: only one ahead of it does. */
export const yieldsBand = (mine: BandMod, beneath: string | undefined): boolean => {
  const at = BAND_PRECEDENCE.indexOf(beneath as BandMod)

  return at !== -1 && at < BAND_PRECEDENCE.indexOf(mine)
}
