/**
 * Oldest-TODO selection, seen/skip records, merged-branch suggestions, and
 * the status and log lines. No engine, and no git process of its own.
 */

export const STATUS_COLUMNS = 48
export const ELLIPSIS = '…'
export const GIT_TIMEOUT_MS = 3000
export const USAGE = '/chore seen · /chore skip'
export const NOTHING_TO_MARK = 'no chore to mark yet · the file and age show when a turn ends'
export const SEEN_LINE = 'seen · this TODO will not be shown again'
export const SKIP_LINE = 'skipped · another TODO will show first'
export const PROGRESS_UNREAD = "couldn't read your progress · nothing was changed · try /chore again"
export const SAVED_FAIL = 'the mark could not be saved · try /chore again'
export const SEEN_KEY = 'seen'
export const SKIP_KEY = 'skipped'

export type TodoHit = { path: string; line: number; text: string; at: number }

export const todoId = (hit: { path: string; line: number; text: string }): string =>
  `${hit.path}\n${hit.line}\n${hit.text}`

export type GrepRow = { path: string; line: number; raw: string }

/** `git grep -n` lines: path:line:text. A line that is not that shape is skipped. */
export const parseGrep = (stdout: string): GrepRow[] => {
  const rows: GrepRow[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const match = /^(.*?):(\d+):(.*)$/.exec(line)
    if (match === null) continue
    const path = match[1] ?? ''
    const lineNo = Number(match[2])
    const raw = match[3] ?? ''
    if (path === '' || !Number.isInteger(lineNo) || lineNo < 1) continue
    rows.push({ path, line: lineNo, raw })
  }

  return rows
}

/** Words after TODO or FIXME. A bare tag is the tag itself. Other comments are returned as trimmed text. */
export const commentText = (raw: string): string => {
  const stripped = raw
    .replace(/^\s*\/\*+/, '')
    .replace(/^\s*\/\//, '')
    .replace(/^\s*#/, '')
    .replace(/^\s*<!--/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/-->\s*$/, '')
    .trim()
  const match = /^(?:.*?)(\bTODO\b|\bFIXME\b)\s*:?\s*(.*)$/.exec(stripped)
  if (match === null) return stripped
  const tag = match[1] ?? 'TODO'
  const rest = (match[2] ?? '').trim()

  return rest === '' ? tag : rest
}

/** Seconds on the line from `git blame --line-porcelain`. */
export const parseBlameTime = (porcelain: string): number | undefined => {
  const match = /^author-time (\d+)$/m.exec(porcelain)
  if (match === null) return undefined
  const seconds = Number(match[1])
  if (!Number.isInteger(seconds) || seconds < 0) return undefined

  return seconds
}

const byOldest = (a: TodoHit, b: TodoHit): number => {
  if (a.at !== b.at) return a.at - b.at
  if (a.path !== b.path) return a.path < b.path ? -1 : 1

  return a.line - b.line
}

export const oldestTodo = (hits: readonly TodoHit[]): TodoHit | undefined => {
  if (hits.length === 0) return undefined

  return [...hits].sort(byOldest)[0]
}

export const pickTodo = (
  hits: readonly TodoHit[],
  seen: readonly string[],
  skipped: readonly string[],
): TodoHit | undefined => {
  const seenSet = new Set(seen)
  const skippedSet = new Set(skipped)
  const unseen = hits.filter(hit => !seenSet.has(todoId(hit)))
  if (unseen.length === 0) return undefined
  const unskipped = unseen.filter(hit => !skippedSet.has(todoId(hit)))
  const pool = unskipped.length > 0 ? unskipped : unseen

  return oldestTodo(pool)
}

/** `git symbolic-ref refs/remotes/origin/HEAD`. Anything else is not a default branch. */
export const parseOriginHead = (stdout: string): string | undefined => {
  const ref = stdout.trim()
  if (ref === '' || ref.includes('\n')) return undefined
  if (!/^refs\/remotes\/[^/\s]+\/.+$/.test(ref)) return undefined

  return ref
}

export const defaultBranchName = (originHead: string): string => {
  const parts = originHead.split('/')

  return parts[parts.length - 1] ?? originHead
}

export const parseMergedBranches = (
  stdout: string,
  defaultName: string,
  current: string | undefined,
): string[] => {
  const names: string[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const marked = line.startsWith('*') || line.startsWith('+')
    const name = (marked ? line.slice(1) : line).trim()
    if (name === '' || name.startsWith('(')) continue
    if (name === defaultName) continue
    if (current !== undefined && current !== '' && name === current) continue
    if (marked) continue
    names.push(name)
  }

  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export const pickDeadBranch = (names: readonly string[]): string | undefined => {
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return sorted[0]
}

export const ageLine = (atMs: number, nowMs: number): string => {
  const days = Math.floor((nowMs - atMs) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return '1 day old'
  const years = Math.floor(days / 365)
  if (years >= 1) return years === 1 ? '1 year old' : `${years} years old`

  return `${days} days old`
}

export const truncateColumns = (text: string, max: number): string => {
  const chars = [...text]
  if (chars.length <= max) return text
  const budget = Math.max(0, max - ELLIPSIS.length)

  return chars.slice(0, budget).join('') + ELLIPSIS
}

export const statusFor = (todoText: string | undefined, branch: string | undefined): string | undefined => {
  if (todoText !== undefined && branch !== undefined) return truncateColumns(`${todoText} · ${branch}`, STATUS_COLUMNS)
  if (todoText !== undefined) return truncateColumns(todoText, STATUS_COLUMNS)
  if (branch !== undefined) return truncateColumns(branch, STATUS_COLUMNS)

  return undefined
}

export const todoLogLine = (hit: TodoHit, nowMs: number): string => `${hit.path}:${hit.line} · ${ageLine(hit.at, nowMs)}`

const SAFE_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/

/** Ordinary names stay bare. Unusual names, including one that starts with -, are quoted. */
export const branchLogLine = (name: string): string => {
  if (SAFE_BRANCH.test(name)) return `git branch -d ${name}`

  return `git branch -d -- '${name.replace(/'/g, "'\\''")}'`
}

export const parseChoreCommand = (args: unknown): 'seen' | 'skip' | 'invalid' => {
  const word = typeof args === 'string' ? args.trim().toLowerCase() : ''
  if (word === 'seen' || word === 'skip') return word

  return 'invalid'
}

export const toStored = (ids: readonly string[]): { v: 1; ids: string[] } => ({ v: 1, ids: [...ids] })

export const recordsFromStore = (value: unknown): string[] | 'invalid' | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return 'invalid'
  const row = value as { v?: unknown; ids?: unknown }
  if (row.v !== 1 || !Array.isArray(row.ids) || row.ids.some(id => typeof id !== 'string')) return 'invalid'

  return [...row.ids]
}

/**
 * True when this argv would change the repo or delete a branch.
 * Read-only calls used here (grep, blame, symbolic-ref, branch --merged) are false.
 */
export const mutatingGitArgv = (argv: readonly string[]): boolean => {
  const raw = argv[0] === 'git' ? argv.slice(1) : [...argv]
  const args = raw[0] === '-c' ? raw.slice(2) : raw
  const cmd = args[0]
  if (
    cmd === 'checkout' ||
    cmd === 'commit' ||
    cmd === 'reset' ||
    cmd === 'rebase' ||
    cmd === 'merge' ||
    cmd === 'push' ||
    cmd === 'add' ||
    cmd === 'rm' ||
    cmd === 'clean' ||
    cmd === 'stash'
  ) {
    return true
  }
  if (cmd === 'branch') {
    return args.some(part => part === '-d' || part === '-D' || part === '--delete' || part === '-m' || part === '-M')
  }

  return false
}
