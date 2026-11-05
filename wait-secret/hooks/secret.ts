/**
 * Pure secret-flag logic: no engine, no $, so `claude plugin test` exercises
 * it directly. It only ever reads lines a diff added and holds them to a short
 * list of patterns. It never writes a file, blocks a tool, or makes a network
 * call, and what it returns never carries a full value: a prefix and the last
 * four characters at most.
 */

import type { AddedLine, Baseline, FileAdds, Hit, TreeScan } from '../types'

/** Glance cap: past this, one overflow line instead of another row. */
export const MAX_ROWS = 8

/** The most hits one turn keeps. Past this nobody reads them one by one anyway. */
const MAX_HITS = 100

/** The most added lines one turn reads, and the most of one line: a minified bundle is not a config. */
const MAX_LINES = 20_000
const MAX_LINE_CHARS = 2_000

/** Card copy. The title is the whole title — no tag beside it. */
export const TITLE = 'Possible secrets in what this turn wrote'
export const SUBTITLE = 'Local pattern match, masked — nothing blocked, edited or uploaded'
export const DISMISS_LABEL = 'Close'
export const DISABLE_LABEL = "Don't show again"

/** The `enabled` field's title: the command lines name it as the way back. */
const ENABLED_TITLE = 'Flag likely secrets a turn wrote'

/** A line carrying this, after `#` or `//`, is never flagged. */
export const IGNORE_MARK = /(?:#|\/\/)\s*wait-secret:\s*ignore\b/

/** `N possible secret(s)`. It never names what kind: the person beside you reads the status line too. */
export const statusLine = (count: number): string | undefined =>
  count === 0 ? undefined : `${count} possible secret${count === 1 ? '' : 's'}`

/** `N more…`, with the spec's ellipsis. */
export const overflowLine = (count: number): string => `${count} more…`

/** One row: `path:line  sk-…3f9a  (OpenAI key?)`. */
export const rowLine = (hit: Hit): string => `${hit.path}:${hit.line}  ${hit.masked}  (${hit.kind})`

// ---------------------------------------------------------------------------
// Masking and entropy
// ---------------------------------------------------------------------------

/** A value as the card shows it: the prefix it was matched by, an ellipsis, and its last four characters. */
export const mask = (prefix: string, value: string): string => `${prefix}…${value.slice(-4)}`

/** Shannon entropy in bits per character. */
export const entropyOf = (text: string): number => {
  if (text === '') return 0
  const counts = new Map<string, number>()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const share = count / text.length
    bits -= share * Math.log2(share)
  }

  return bits
}

/** Words that make a value a placeholder, not a key: `your-api-key-here`, `changeme`, `<token>`. */
const PLACEHOLDER = /your|example|sample|placeholder|changeme|dummy|redacted|xxxx|\*\*\*\*|<|>|\$\{|\{\{|process\.env|os\.environ/i

/**
 * Whether a free-form value (one no known prefix vouches for) reads like a
 * secret: long enough, letters and digits mixed, varied enough, and not a
 * placeholder, a reference to an environment variable, or a path.
 */
export const looksRandom = (value: string): boolean => {
  if (value.length < 16 || PLACEHOLDER.test(value) || value.startsWith('$')) return false
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false
  if (/^[\w.-]*\/[\w./-]*$/.test(value) && !/[+=]/.test(value)) return false

  return entropyOf(value) >= 3.5
}

/** A value with a known prefix still has to vary: `sk-xxxxxxxxxxxxxxxxxxxx` is a placeholder. */
const varied = (body: string): boolean => new Set(body).size >= 6 && !PLACEHOLDER.test(body)

// ---------------------------------------------------------------------------
// The rules: eight of them, first match on a line wins
// ---------------------------------------------------------------------------

type Found = { masked: string; kind: string }

type Rule = { name: string; find: (text: string, isEnvFile: boolean) => Found | undefined }

/** A rule for a token with a known prefix: the prefix shown, the rest masked to its last four. */
const prefixed = (name: string, kind: string, pattern: RegExp, shown: (match: string) => string): Rule => ({
  name,
  find: text => {
    for (const match of text.matchAll(pattern)) {
      const value = match[0]
      const prefix = shown(value)
      if (varied(value.slice(prefix.length))) return { masked: mask(prefix, value), kind }
    }

    return undefined
  },
})

const ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential|auth[_-]?key)[A-Za-z0-9_]*)["']?\s*(?::=|=>|[:=])\s*["'`]?([A-Za-z0-9_\-+/=.~]{16,})/gi

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^\s"'#]+)/

export const RULES: readonly Rule[] = [
  prefixed('anthropic', 'Anthropic key?', /\bsk-ant-[A-Za-z0-9_-]{20,}/g, () => 'sk-ant-'),
  prefixed('openai', 'OpenAI key?', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g, () => 'sk-'),
  prefixed('aws', 'AWS key?', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, value => value.slice(0, 4)),
  prefixed('github', 'GitHub token?', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, value =>
    value.startsWith('github_pat_') ? 'github_pat_' : value.slice(0, 4),
  ),
  prefixed('slack', 'Slack token?', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, value => value.slice(0, 5)),
  {
    name: 'private-key',
    find: text =>
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)
        ? { masked: '-----BEGIN … PRIVATE KEY-----', kind: 'private key?' }
        : undefined,
  },
  {
    name: 'env',
    find: (text, isEnvFile) => {
      if (!isEnvFile) return undefined
      const match = ENV_LINE.exec(text)
      const [, name = '', value = ''] = match ?? []

      return match !== null && looksRandom(value) ? { masked: mask(`${name}=`, value), kind: 'env value?' } : undefined
    },
  },
  {
    name: 'assignment',
    find: text => {
      for (const match of text.matchAll(ASSIGNMENT)) {
        const [, name = '', value = ''] = match
        if (looksRandom(value)) return { masked: mask(`${name}=`, value), kind: 'API key?' }
      }

      return undefined
    },
  },
]

/** `.env`, `.env.local`, `prod.env`: a file whose every line is `KEY=value`. `.env.example` is a template. */
export const isEnvFile = (path: string): boolean => {
  const name = path.split('/').at(-1) ?? ''
  if (/\.(?:example|sample|template|dist)$/i.test(name)) return false

  return /^\.env(?:\..+)?$/i.test(name) || /\.env$/i.test(name)
}

/** What one added line looks like, or undefined: ignored, or no rule matches. */
export const scanLine = (text: string, envFile = false): Found | undefined => {
  const line = text.slice(0, MAX_LINE_CHARS)
  if (IGNORE_MARK.test(line)) return undefined
  for (const rule of RULES) {
    const found = rule.find(line, envFile)
    if (found !== undefined) return found
  }

  return undefined
}

/** Every hit in some files' added lines, file by file, line by line, up to the caps. */
export const hitsIn = (files: readonly FileAdds[]): Hit[] => {
  const hits: Hit[] = []
  let read = 0
  for (const file of files) {
    const envFile = isEnvFile(file.path)
    for (const added of file.lines) {
      if (read >= MAX_LINES || hits.length >= MAX_HITS) return hits
      read += 1
      const found = scanLine(added.text, envFile)
      if (found !== undefined) hits.push({ path: file.path, line: added.line, ...found })
    }
  }

  return hits
}

// ---------------------------------------------------------------------------
// Diff parsing: the lines a diff adds, with their line numbers
// ---------------------------------------------------------------------------

/** The file name off a `+++` line, the way `git diff --no-prefix` writes it. */
const sidePath = (rest: string): string => {
  const cut = rest.indexOf('\t')
  const name = cut < 0 ? rest : rest.slice(0, cut)

  return name.length > 1 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name
}

/**
 * Splits `git ls-files -z` output into paths. NUL is the only separator and
 * nothing is trimmed: a name may begin or end with a space.
 */
export const splitNul = (output: string): string[] => output.split('\0').filter(path => path !== '')

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Reads `git diff --no-color --no-prefix` output (one or several,
 * concatenated) into the lines each file gains, numbered as the file is now.
 * A deleted file gains nothing; a binary file is not read.
 */
export const parseAddedLines = (output: string): FileAdds[] => {
  const files: FileAdds[] = []
  let current: { path: string; lines: AddedLine[] } | null = null
  let next = 0
  let inHunk = false
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --no-index ')) {
      if (current !== null && current.lines.length > 0) files.push(current)
      current = null
      inHunk = false
      continue
    }
    if (!inHunk) {
      if (line.startsWith('+++ ')) {
        const path = sidePath(line.slice(4))
        current = path === '/dev/null' ? null : { path, lines: [] }
        continue
      }
      const hunk = HUNK.exec(line)
      if (hunk === null) continue
      inHunk = true
      next = Number(hunk[1])
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      next = Number(hunk[1])
      continue
    }
    if (line.startsWith('+')) {
      current?.lines.push({ line: next, text: line.slice(1) })
      next += 1
    } else if (line.startsWith(' ')) {
      next += 1
    }
  }
  if (current !== null && current.lines.length > 0) files.push(current)

  return files
}

// ---------------------------------------------------------------------------
// This turn, against the tree the turn started from
// ---------------------------------------------------------------------------

/** FNV-1a, base 36: enough to tell one added line from another, and not the line. */
export const digestOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(36)
}

/** The baseline a turn starts from: per file, a digest of each line already added. */
export const baselineOf = (turnId: string, scan: TreeScan): Baseline => {
  if (!scan.ok) return { turnId, ok: false, seen: {} }
  const seen: Record<string, string[]> = {}
  for (const file of scan.files) seen[file.path] = file.lines.map(added => digestOf(added.text))

  return { turnId, ok: true, seen }
}

/**
 * The lines this turn added: those in the later scan that the baseline did
 * not already hold. A line added twice before the turn and three times by
 * the end is one new line.
 */
export const turnAdds = (before: Baseline, after: TreeScan): FileAdds[] => {
  if (!before.ok || !after.ok) return []
  const out: FileAdds[] = []
  for (const file of after.files) {
    const left = new Map<string, number>()
    for (const digest of before.seen[file.path] ?? []) left.set(digest, (left.get(digest) ?? 0) + 1)
    const lines = file.lines.filter(added => {
      const digest = digestOf(added.text)
      const count = left.get(digest) ?? 0
      if (count === 0) return true
      left.set(digest, count - 1)

      return false
    })
    if (lines.length > 0) out.push({ path: file.path, lines })
  }

  return out
}

export type Card = { hits: Hit[]; overflow: number }

/** The list for one turn, or null: no baseline, a failed scan, or nothing that looks like a secret. */
export const cardFor = (before: Baseline | null, after: TreeScan | null): Card | null => {
  if (before === null || after === null) return null
  const hits = hitsIn(turnAdds(before, after))
  if (hits.length === 0) return null
  const shown = hits.slice(0, MAX_ROWS)

  return { hits: shown, overflow: hits.length - shown.length }
}

// ---------------------------------------------------------------------------
// The command and the settings row
// ---------------------------------------------------------------------------

/**
 * The `/config` row this plugin's `enabled` field answers to: a row's key is
 * `<plugin>.<field>`, and a working copy loaded with `--plugin-dir` may carry
 * a suffix on its name (`wait-secret@inline`).
 */
export const ENABLED_ROW = /^wait-secret(@[\w-]+)?\.enabled$/

/** The key `$.config.set` takes for `enabled`, read off the rows `$.config.list()` returns. */
export const enabledRowKey = (rows: readonly { key: string }[]): string =>
  rows.find(row => ENABLED_ROW.test(row.key))?.key ?? 'wait-secret.enabled'

/** What `/wait-secret` answers once it has flipped the setting on. */
export const turnedOnLine = (): string =>
  'on · a masked list once a turn writes something that looks like a key · /wait-secret turns it off'

/** What `/wait-secret` answers once the setting is off, and the two places that turn it back on. */
export const turnedOffLine = (): string =>
  `off · /wait-secret turns it back on · /plugin → wait-secret → ${ENABLED_TITLE}`

/** The setting could not be written, but the list is still off on this machine. */
export const turnedOffLocallyLine = (reason: string): string =>
  `off · the setting did not change (${reason}) · kept off on this machine · /wait-secret turns it back on`

/** What `/wait-secret` answers when a turn-on was refused: nothing moved. */
export const toggleRefusedLine = (reason: string): string =>
  `still off · the setting did not change (${reason}) · /plugin → wait-secret → ${ENABLED_TITLE}`

// ---------------------------------------------------------------------------
// The row above the prompt
// ---------------------------------------------------------------------------

/**
 * The waitroom mods that draw into the row above the prompt, the one with
 * precedence first. Theirs end before this card, and a mod they do not name
 * is behind them, so their order and this one agree without a change to
 * theirs. While the card waits its turn, the status line carries the count.
 */
export const BAND_PRECEDENCE = [
  'wait-breathe',
  'wait-ship',
  'bet-on-your-agent',
  'wait-scope',
  'wait-secret',
] as const

export type BandMod = (typeof BAND_PRECEDENCE)[number]

/** The plugin whose hook drew a band tree, off the stamp the engine puts on its root. */
export const drawnBy = (tree: unknown): string | undefined => {
  const part = typeof tree === 'object' && tree !== null ? (tree as { part?: { plugin?: unknown } }).part : undefined

  return typeof part?.plugin === 'string' ? part.plugin : undefined
}

/** Whether the row a mod drew beneath `mine` keeps the band: only one ahead of it does. */
export const yieldsBand = (mine: BandMod, beneath: string | undefined): boolean => {
  const at = BAND_PRECEDENCE.indexOf(beneath as BandMod)

  return at !== -1 && at < BAND_PRECEDENCE.indexOf(mine)
}
