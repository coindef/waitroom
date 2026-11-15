/**
 * Pure shipping-kit logic: no engine, no $, so `claude plugin test` exercises
 * it directly. Everything here is deterministic text generation — no model
 * call, no network, no randomness.
 */

/** One file the turn's diff touched. */
export type FileChange = {
  path: string
  added: number
  removed: number
  kind: 'added' | 'modified' | 'deleted'
}

export type ConventionalType = 'feat' | 'fix' | 'docs' | 'test' | 'refactor' | 'chore'

/** What the repository's recent commit subjects say about how to write the next one. */
export type CommitStyle = {
  kind: 'conventional' | 'freeform'
  capitalized: boolean
  tense: 'imperative' | 'past'
}

export type Commit = { subject: string; body: string[] }

export type Kit = {
  commit: Commit
  prBody: string
  /** Absent when there is nothing to draft it against — no CHANGELOG.md, or the setting is off. */
  changelogEntry?: string
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * The file name off a `---` or `+++` line, the way `git diff --no-prefix`
 * writes it: tab-terminated when it holds a space, and C-quoted when the
 * name has a quote, a backslash, or (unless `core.quotePath` is off) a
 * non-ASCII byte. None of that belongs in the name.
 */
const C_ESCAPE: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '\\': 92,
  '"': 34,
}

/** Git's C-quoting, undone: `\"`, `\\`, and `\nnn` octal bytes, then UTF-8. */
const unquoteGit = (inner: string): string => {
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i)
    if (ch !== '\\') {
      const code = inner.charCodeAt(i)
      if (code < 128) bytes.push(code)
      else for (const byte of new TextEncoder().encode(ch)) bytes.push(byte)
      continue
    }
    const next = inner.charAt(i + 1)
    if (next === '') break
    i += 1
    const simple = C_ESCAPE[next]
    if (simple !== undefined) {
      bytes.push(simple)
      continue
    }
    if (next >= '0' && next <= '7') {
      let oct = next
      for (let k = 0; k < 2; k++) {
        const digit = inner.charAt(i + 1)
        if (digit < '0' || digit > '7') break
        oct += digit
        i += 1
      }
      bytes.push(Number.parseInt(oct, 8))
      continue
    }
    bytes.push(next.charCodeAt(0))
  }

  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/** C0 controls that read better as the C escape than as `\xHH`. ESC stays `\x1b`. */
const NAMED_CONTROL: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
}

/**
 * A code point that must not be written into a terminal or a commit message:
 * C0, DEL, C1, and the bidi/isolate marks that reorder the line.
 */
const hidesText = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

/** The same character, as text a terminal will show rather than obey. */
const visibleEscape = (code: number): string => {
  const named = NAMED_CONTROL[code]
  if (named !== undefined) return named
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, '0')}`

  return `\\u${code.toString(16).padStart(4, '0')}`
}

/** After unquoting: controls and bidi marks become `\x1b`, `\n`, `\u202e`, and the like. */
const visiblePath = (text: string): string => {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += hidesText(code) ? visibleEscape(code) : ch
  }

  return out
}

export const sidePath = (rest: string): string => {
  const cut = rest.indexOf('\t')
  const name = cut < 0 ? rest : rest.slice(0, cut)
  const raw = name.length > 1 && name.startsWith('"') && name.endsWith('"') ? unquoteGit(name.slice(1, -1)) : name

  return visiblePath(raw)
}

const BINARY_LINE = /^Binary files (.+) and (.+) differ$/

/**
 * Reads `git diff --no-color --no-prefix` output (one or several, concatenated)
 * into a file-level change list: which files, how many lines each way, and
 * whether a file is new, gone, or just different.
 */
export const parseDiffFiles = (output: string): FileChange[] => {
  const files: FileChange[] = []
  let minus = ''
  let plus = ''
  let added = 0
  let removed = 0
  let hasHeader = false
  // `---` / `+++` name a file only before the first hunk. From `@@` until the
  // next diff, a removed `-- …` line is `--- …` and an added `++ …` line is `+++ …`.
  let inHunk = false

  const flush = () => {
    if (!hasHeader) return
    const isNew = minus === '/dev/null'
    const isDeleted = plus === '/dev/null'
    files.push({
      path: isDeleted ? minus : plus,
      added,
      removed,
      kind: isNew ? 'added' : isDeleted ? 'deleted' : 'modified',
    })
  }

  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --no-index ')) {
      flush()
      minus = ''
      plus = ''
      added = 0
      removed = 0
      hasHeader = false
      inHunk = false
      continue
    }
    const binary = BINARY_LINE.exec(line)
    if (binary) {
      flush()
      const [, left, right] = binary as unknown as [string, string, string]
      files.push({
        path: visiblePath(right === '/dev/null' ? left : right),
        added: 0,
        removed: 0,
        kind: left === '/dev/null' ? 'added' : right === '/dev/null' ? 'deleted' : 'modified',
      })
      hasHeader = false
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      minus = sidePath(line.slice(4))
      hasHeader = true
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      plus = sidePath(line.slice(4))
      hasHeader = true
      continue
    }
    if (line.startsWith('+')) {
      added++
      continue
    }
    if (line.startsWith('-')) {
      removed++
      continue
    }
  }
  flush()

  return files
}

/**
 * Splits `git ls-files -z` output into paths. NUL is the only separator and
 * nothing is trimmed: a name may begin or end with a space.
 */
export const splitNul = (output: string): string[] => output.split('\0').filter(path => path !== '')

/**
 * stdout of a diff git actually produced. Exit 1 is how `--no-index` reports
 * "the sides differ". The same exit with nothing on stdout is git failing to
 * open the path, which is not an empty diff.
 */
export const readDiff = (exitCode: number, stdout: string): string | undefined => {
  if (exitCode === 0) return stdout
  if (exitCode === 1 && stdout !== '') return stdout

  return undefined
}

/** The dim line under a kit when git listed a file and could not read it. */
export const skippedLine = (count: number): string =>
  count === 1 ? "1 file skipped: git couldn't read it" : `${count} files skipped: git couldn't read them`

/**
 * The tracked-diff argv, after `git`. `core.quotePath=false` keeps a non-ASCII
 * name raw in the headers. `--no-ext-diff` keeps a `diff.external` tool from
 * replacing the diff this parser reads.
 */
export const TRACKED_DIFF_ARGS = [
  '-c',
  'core.quotePath=false',
  'diff',
  'HEAD',
  '--no-color',
  '--no-prefix',
  '--no-ext-diff',
] as const

/** `git ls-files -z`: NUL-separated, never C-quoted. */
export const UNTRACKED_LIST_ARGS = ['ls-files', '-z', '--others', '--exclude-standard'] as const

/** One untracked file against `/dev/null`, the same quoting rules as the tracked diff. */
export const untrackedDiffArgs = (path: string): string[] => [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-prefix',
  '--no-ext-diff',
  '--no-index',
  '--',
  '/dev/null',
  path,
]

/** `git log --format=%s` output into one subject per line, blanks dropped. */
export const parseSubjects = (output: string): string[] =>
  output
    .split('\n')
    .map(one => one.trim())
    .filter(one => one !== '')

// ---------------------------------------------------------------------------
// Style inference
// ---------------------------------------------------------------------------

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: .+/
const PAST_TENSE_START = /^[A-Za-z]+ed\b/

/**
 * What the last ~20 subjects say about how to write the next one: whether
 * conventional commits dominate, whether the prevailing subject starts
 * capitalized, and whether it leans imperative or past tense.
 */
export const inferStyle = (subjects: readonly string[]): CommitStyle => {
  const sample = subjects.map(one => one.trim()).filter(one => one !== '')
  if (sample.length === 0) return { kind: 'freeform', capitalized: true, tense: 'imperative' }

  const conventional = sample.filter(one => CONVENTIONAL.test(one))
  const capitalized = sample.filter(one => /^[A-Z]/.test(one))
  const past = sample.filter(one => PAST_TENSE_START.test(one))

  return {
    kind: conventional.length / sample.length > 0.5 ? 'conventional' : 'freeform',
    capitalized: capitalized.length >= sample.length / 2,
    tense: past.length > sample.length / 2 ? 'past' : 'imperative',
  }
}

// ---------------------------------------------------------------------------
// What kind of change this is, and where
// ---------------------------------------------------------------------------

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//i
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/i

export const isTestFile = (path: string): boolean => TEST_PATH.test(path) || TEST_FILE.test(path)

const DOC_FILE = /\.(md|mdx)$/i
const DOC_NAME = /^(README|CHANGELOG|LICENSE|CONTRIBUTING)(\.|$)/i

export const isDocFile = (path: string): boolean => {
  const base = path.split('/').pop() ?? path

  return DOC_FILE.test(path) || DOC_NAME.test(base) || /(^|\/)docs\//i.test(path)
}

const CHORE_NAME =
  /^(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock|tsconfig(\..+)?\.json|\.gitignore|\.editorconfig|\.npmrc)$/i

export const isChoreFile = (path: string): boolean => {
  const base = path.split('/').pop() ?? path

  return CHORE_NAME.test(base) || /(^|\/)\.github\//.test(path)
}

/** A best-effort, fully deterministic guess at the conventional-commit type, from the files alone. */
export const typeOf = (files: readonly FileChange[]): ConventionalType => {
  if (files.length === 0) return 'chore'
  if (files.every(one => isTestFile(one.path))) return 'test'
  if (files.every(one => isDocFile(one.path))) return 'docs'
  if (files.every(one => isChoreFile(one.path))) return 'chore'
  if (files.some(one => one.kind === 'added')) return 'feat'

  const added = files.reduce((sum, one) => sum + one.added, 0)
  const removed = files.reduce((sum, one) => sum + one.removed, 0)

  return removed > added ? 'refactor' : 'fix'
}

/** Each file's top-level folder (`.` for one with none), in first-seen order. */
export const areasOf = (files: readonly FileChange[]): Map<string, FileChange[]> => {
  const map = new Map<string, FileChange[]>()
  for (const file of files) {
    const area = file.path.includes('/') ? (file.path.split('/')[0] as string) : '.'
    const list = map.get(area)
    if (list) list.push(file)
    else map.set(area, [file])
  }

  return map
}

/** The one area every changed file shares, or undefined when they span more than one. */
export const scopeOf = (files: readonly FileChange[]): string | undefined => {
  const areas = [...areasOf(files).keys()]

  return areas.length === 1 && areas[0] !== '.' ? areas[0] : undefined
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** The majority action across `files`: what most of them had done to them. */
export const verbFor = (files: readonly FileChange[]): 'add' | 'update' | 'remove' => {
  let added = 0
  let modified = 0
  let deleted = 0
  for (const one of files) {
    if (one.kind === 'added') added++
    else if (one.kind === 'deleted') deleted++
    else modified++
  }
  if (added >= modified && added >= deleted) return 'add'

  return deleted > modified ? 'remove' : 'update'
}

const PAST_TENSE: Record<string, string> = { add: 'added', update: 'updated', remove: 'removed' }

const pastTenseOf = (verb: string): string => PAST_TENSE[verb] ?? `${verb}ed`

export const capitalize = (text: string): string => (text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1))

/** Cuts `text` to `max` characters, the last one an ellipsis when it had to. */
export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`

const FILE_LIST_CAP = 5

/** Up to `FILE_LIST_CAP` paths, comma-joined, with the rest counted rather than named. */
export const fileList = (files: readonly FileChange[]): string => {
  const shown = files.slice(0, FILE_LIST_CAP).map(one => one.path)
  const left = files.length - shown.length

  return left > 0 ? `${shown.join(', ')} +${left} more` : shown.join(', ')
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

const SUBJECT_MAX = 72

export const subjectOf = (
  files: readonly FileChange[],
  style: CommitStyle,
  type: ConventionalType,
  scope: string | undefined,
): string => {
  const verb = verbFor(files)
  const noun =
    files.length === 1
      ? (files[0] as FileChange).path
      : `${files.length} files${scope ? '' : areasOf(files).size > 1 ? ' across several areas' : ''}`

  if (style.kind === 'conventional') {
    return truncate(`${type}${scope ? `(${scope})` : ''}: ${verb} ${noun}`, SUBJECT_MAX)
  }

  const lead = style.tense === 'past' ? pastTenseOf(verb) : verb

  return truncate(`${style.capitalized ? capitalize(lead) : lead} ${noun}`, SUBJECT_MAX)
}

const FILES_PER_BODY_BULLET_CAP = 8

/** Bullets grouped by area when the diff spans more than one, else one bullet per file. */
export const bodyOf = (files: readonly FileChange[]): string[] => {
  const areas = areasOf(files)
  if (areas.size > 1) {
    return [...areas.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([area, items]) => `- ${area}: ${verbFor(items)} ${fileList(items)}`)
  }

  const capped = files.slice(0, FILES_PER_BODY_BULLET_CAP)
  const left = files.length - capped.length
  const lines = capped.map(one => `- ${verbFor([one])} ${one.path}`)

  return left > 0 ? [...lines, `- +${left} more file${left === 1 ? '' : 's'}`] : lines
}

export const commitOf = (files: readonly FileChange[], subjects: readonly string[]): Commit => {
  const style = inferStyle(subjects)
  const type = typeOf(files)
  const scope = scopeOf(files)

  return { subject: subjectOf(files, style, type, scope), body: bodyOf(files) }
}

/** `git commit -F`'s own format: subject, a blank line, then the body. */
export const commitFileText = (commit: Commit): string =>
  commit.body.length > 0 ? `${commit.subject}\n\n${commit.body.join('\n')}\n` : `${commit.subject}\n`

// ---------------------------------------------------------------------------
// PR description
// ---------------------------------------------------------------------------

const SUMMARY_LINE: Record<ConventionalType, (area: string) => string> = {
  feat: area => `Adds new functionality in ${area}`,
  fix: area => `Fixes behavior in ${area}`,
  docs: area => `Updates documentation in ${area}`,
  test: area => `Adds or updates tests in ${area}`,
  refactor: area => `Restructures code in ${area}`,
  chore: area => `Updates project configuration in ${area}`,
}

/**
 * 2-4 bullets naming what changed and roughly why, read off the files alone —
 * a diff carries no rationale a deterministic pass can honestly report, so
 * "why" here means "what kind of change, where", not a design justification.
 *
 * Each area's own kind drives its own bullet's wording, rather than the
 * single kind the whole diff reads as: an area that only deleted files reads
 * as a removal even where another area in the same diff added a new one.
 */
export const summaryBullets = (files: readonly FileChange[]): string[] => {
  const areas = [...areasOf(files).entries()].sort(([a], [b]) => a.localeCompare(b))
  const bullets = areas
    .slice(0, 4)
    .map(
      ([area, items]) =>
        `- ${SUMMARY_LINE[typeOf(items)](area === '.' ? 'the repository root' : area)} (${fileList(items)})`,
    )

  const hasTests = files.some(one => isTestFile(one.path))
  const allTests = files.every(one => isTestFile(one.path))
  if (hasTests && !allTests && bullets.length < 4) bullets.push('- Includes test coverage for the change.')

  const deleted = files.filter(one => one.kind === 'deleted')
  if (bullets.length < 2 && deleted.length > 0) bullets.push(`- Removes ${fileList(deleted)}.`)

  return bullets.length > 0 ? bullets : ['- No changes.']
}

export const testPlanLines = (files: readonly FileChange[]): string[] => {
  const tests = files.filter(one => isTestFile(one.path))
  const lines = tests.map(one => `- [ ] \`${one.path}\` passes`)
  lines.push('- [ ] Manually verify the change in context')

  return lines
}

export const prBodyOf = (files: readonly FileChange[]): string =>
  [
    '## Summary',
    summaryBullets(files).join('\n'),
    '',
    '## Changes',
    bodyOf(files).join('\n'),
    '',
    '## Test plan',
    testPlanLines(files).join('\n'),
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// Changelog entry
// ---------------------------------------------------------------------------

const CHANGELOG_HEADING: Record<ConventionalType, 'Added' | 'Changed' | 'Fixed'> = {
  feat: 'Added',
  fix: 'Fixed',
  docs: 'Changed',
  test: 'Changed',
  refactor: 'Changed',
  chore: 'Changed',
}

export const changelogHeadingFor = (type: ConventionalType): 'Added' | 'Changed' | 'Fixed' => CHANGELOG_HEADING[type]

/** Whether the changelog's own bullets lead with a bold clause, so the drafted one matches. */
export const bulletStyleOf = (changelogContent: string): 'bold-lead-in' | 'plain' =>
  /^-\s+\*\*/m.test(changelogContent) ? 'bold-lead-in' : 'plain'

const HEADING_ORDER: Array<'Added' | 'Changed' | 'Fixed'> = ['Added', 'Changed', 'Fixed']

/**
 * 1-2 bullets, one per area up to two, in the file's own bullet style, each
 * under the heading its own area's kind picks — a feature added in one area
 * and a fix in another land under separate `### Added` / `### Fixed`
 * sections rather than both under whichever kind the whole diff reads as.
 */
export const changelogEntryOf = (files: readonly FileChange[], style: 'bold-lead-in' | 'plain'): string => {
  const areas = [...areasOf(files).entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 2)
  const byHeading = new Map<'Added' | 'Changed' | 'Fixed', string[]>()
  for (const [area, items] of areas) {
    const verb = verbFor(items)
    const lead = capitalize(area === '.' ? `${verb} ${fileList(items)}` : `${verb} ${fileList(items)} in ${area}`)
    const bullet = style === 'bold-lead-in' ? `- **${lead}.**` : `- ${lead}.`
    const heading = changelogHeadingFor(typeOf(items))
    const bucket = byHeading.get(heading)
    if (bucket) bucket.push(bullet)
    else byHeading.set(heading, [bullet])
  }

  return (
    HEADING_ORDER.filter(heading => byHeading.has(heading))
      .map(heading => `### ${heading}\n${(byHeading.get(heading) as string[]).join('\n')}`)
      .join('\n\n') + '\n'
  )
}

// ---------------------------------------------------------------------------
// The whole kit
// ---------------------------------------------------------------------------

export const kitOf = (
  files: readonly FileChange[],
  subjects: readonly string[],
  changelogContent: string | undefined,
): Kit => {
  const commit = commitOf(files, subjects)
  const prBody = prBodyOf(files)
  const changelogEntry =
    changelogContent === undefined ? undefined : changelogEntryOf(files, bulletStyleOf(changelogContent))

  return changelogEntry === undefined ? { commit, prBody } : { commit, prBody, changelogEntry }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** A rough, human-scale size for a chunk of text: bytes under 1000, else kilobytes. */
export const formatSize = (chars: number): string => {
  if (chars < 1000) return `${chars}B`
  const kb = chars / 1000

  return `${kb.toFixed(kb < 10 ? 1 : 0)}KB`
}

export type ArtifactKind = 'commit' | 'pr' | 'changelog'

/** The command the person runs to apply a written draft — printed, never run. */
export const applyCommandFor = (kind: ArtifactKind, path: string): string => {
  if (kind === 'commit') return `git commit -F ${path}`
  if (kind === 'pr') return `gh pr create --body-file ${path}`

  return `paste ${path} into CHANGELOG.md`
}

/**
 * One transcript line per draft written: where it is and the command to use
 * it. The receipt goes to the transcript rather than the row above the prompt,
 * so it stays readable at any width and scrolls back with the session, and
 * the row is free at once for whatever waited behind the offer.
 */
export const receiptLines = (wrote: readonly { kind: ArtifactKind; path: string }[]): string[] =>
  wrote.map(one => `Draft written: ${one.path} — ${applyCommandFor(one.kind, one.path)}`)

// ---------------------------------------------------------------------------
// The drafts folder and the tree between turns
// ---------------------------------------------------------------------------

/** A repository-relative folder as git names its files: no `./`, no trailing slash. */
const folderOf = (dir: string): string => dir.split('/').filter(part => part !== '' && part !== '.').join('/')

/** Whether a repository-relative `path` sits inside folder `dir`. */
export const isUnder = (path: string, dir: string): boolean => {
  const folder = folderOf(dir)

  return folder !== '' && (path === folder || path.startsWith(`${folder}/`))
}

/**
 * Whether `shipDir` is a folder of its own inside the repository, so a
 * `.gitignore` there can hide the drafts and nothing else: not the root, not
 * an absolute path, never a step up out of the repository.
 */
export const isOwnFolder = (shipDir: string): boolean => {
  const folder = folderOf(shipDir)

  return !shipDir.startsWith('/') && folder !== '' && !folder.split('/').includes('..')
}

/**
 * The drafts folder's own `.gitignore`: everything in it. The drafts are
 * this mod's output, not the turn's changes, so they stay out of `git status`,
 * out of wait-review's queue, and out of the next kit's diff.
 */
export const DRAFTS_GITIGNORE = '*\n'

/**
 * A short fingerprint of the working tree's changes as one scan read them:
 * the same text, the same fingerprint. A turn whose end reads the fingerprint
 * the last scan left changed nothing, and gets no kit (FNV-1a, 32 bits, with
 * the length beside it).
 */
export const fingerprintOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `${text.length}:${hash.toString(16)}`
}

// ---------------------------------------------------------------------------
// The row above the prompt
// ---------------------------------------------------------------------------

/**
 * The waitroom mods that draw into the row above the prompt, the one with
 * precedence first: wait-breathe, then wait-ship, then
 * bet-on-your-agent. Kept in lockstep with the same list in those mods.
 *
 * The row shows one of them at a time. Hooks of different plugins nest in an
 * order the person's installs decide, not this code, so each of the four
 * draws only after asking what is already beneath it (`next(e)`), and hands
 * the row to a mod ahead of it here: whatever the load order, the mod with
 * precedence is the one row on screen, and the others wait for it.
 */
export const BAND_PRECEDENCE = ['wait-breathe', 'wait-ship', 'bet-on-your-agent'] as const

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
