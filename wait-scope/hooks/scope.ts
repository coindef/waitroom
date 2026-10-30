/**
 * Pure scope logic: no engine, no $, so `claude plugin test` exercises it
 * directly. It only ever compares: it names files and holds them to globs or
 * to a prompt's paths, and it never writes a path, reverts an edit, blocks a
 * tool, or makes a network call.
 */

import type { Hint, Scope, ScopeTurn } from '../types'

/** Where a project keeps its own scope: one glob per line, relative to the project root. */
export const SCOPE_FILE = '.claude/wait-scope'

/** Glance cap: past this, one overflow line instead of another file row. */
export const MAX_ROWS = 8

/**
 * The most files one turn keeps. Each is an edit tool's call the model made,
 * so a turn past this is one nobody reads file by file anyway.
 */
const MAX_EDITED = 500

/** The most hints a turn keeps, and the most prompt text read for them: a pasted log is not a request. */
const MAX_HINTS = 100
const MAX_PROMPT_CHARS = 50_000

/** Card copy. The title is the whole title — no tag beside it. */
export const TITLE = 'Changed outside what you asked for'
export const DISMISS_LABEL = 'Close'
export const DISABLE_LABEL = "Don't show again"

/** The mark beside a file the prompt did not name, where no scope holds the turn to globs. */
export const GUESS = '(guess)'

/** The `enabled` field's title: the command lines name it as the way back. */
const ENABLED_TITLE = 'Warn when a turn edits outside the scope'

/** The `globs` field's title. */
const GLOBS_TITLE = 'Files in scope'

/** The card's second line: where the scope came from, and that it only warns. */
export const subtitleOf = (scope: Scope): string => {
  if (scope.source === 'file') return `Scope: ${SCOPE_FILE} — a warning, nothing blocked or undone`
  if (scope.source === 'setting') return `Scope: the ${GLOBS_TITLE} setting — a warning, nothing blocked or undone`

  return 'No scope set — a guess from the paths your prompt named, nothing blocked or undone'
}

/** `N more files…`, with the spec's ellipsis. One file is singular. */
export const overflowLine = (count: number): string => `${count} more file${count === 1 ? '' : 's'}…`

// ---------------------------------------------------------------------------
// Paths, against the project root
// ---------------------------------------------------------------------------

const toSlashes = (path: string): string => path.replace(/\\/g, '/')

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)

/** An absolute path with `.` and `..` resolved and doubled slashes dropped. */
const collapse = (path: string): string => {
  const [head = '', ...rest] = path.split('/')
  const kept: string[] = []
  for (const part of rest) {
    if (part === '' || part === '.') continue
    if (part === '..') kept.pop()
    else kept.push(part)
  }

  return [head, ...kept].join('/')
}

/** A root with forward slashes and no trailing slash: what every path of a turn is read against. */
export const rootOf = (root: string): string => toSlashes(root.trim()).replace(/\/+$/, '')

/**
 * A file's path as wait-scope keeps it: relative to the project root, or
 * absolute where it lies outside the root. A relative path is read from the root.
 */
export const projectPath = (root: string, path: string): string => {
  const base = rootOf(root)
  const raw = toSlashes(path.trim())
  const full = collapse(isAbsolute(raw) ? raw : `${base}/${raw}`)

  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full
}

/** Whether a kept path lies inside the project root, the only place a scope's globs reach. */
const isInsideRoot = (path: string): boolean => path !== '' && !isAbsolute(path)

// ---------------------------------------------------------------------------
// Globs: the person's own scope
// ---------------------------------------------------------------------------

/**
 * One glob as a scope keeps it: forward slashes, anchored at the project root
 * (a leading `./` or `/` says the same thing), and no trailing slash.
 */
const cleanGlob = (glob: string): string =>
  toSlashes(glob.trim())
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/\/+$/, '')

/** A scope's text: one glob per line, commas separating too, blank lines and `#` comment lines left out. */
export const parseGlobs = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => !line.startsWith('#'))
    .flatMap(line => line.split(','))
    .map(cleanGlob)
    .filter(glob => glob !== '')

/**
 * A glob as a whole-path pattern, the way wait-review reads its `ignore`
 * list: `*` within one folder name, `?` one character, `**` across folders,
 * and a double-star-slash that may also match no folder at all.
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

/**
 * Whether a glob covers a path: the path itself, or a folder it sits in, so a
 * glob that names a folder covers everything inside it, as `.gitignore` reads one.
 */
export const globCovers = (glob: string, path: string): boolean => {
  const pattern = globToRegExp(glob)
  if (pattern.test(path)) return true
  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    if (pattern.test(path.slice(0, cut))) return true
  }

  return false
}

/** Whether an edited file is in the scope: inside the project root, and covered by one of its globs. */
export const inScope = (path: string, globs: readonly string[]): boolean =>
  isInsideRoot(path) && globs.some(glob => globCovers(glob, path))

/**
 * The scope a turn starts with. The project's own file wins once it names a
 * glob; the setting stands in for a project without one; neither is no
 * scope, where only the prompt's paths are read, and only as a guess.
 */
export const resolveScope = (fileText: string | undefined, setting: unknown): Scope => {
  const fromFile = fileText === undefined ? [] : parseGlobs(fileText)
  if (fromFile.length > 0) return { source: 'file', globs: fromFile }
  const fromSetting = typeof setting === 'string' ? parseGlobs(setting) : []
  if (fromSetting.length > 0) return { source: 'setting', globs: fromSetting }

  return { source: 'none' }
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * The tools whose call writes a file, and the argument that names it.
 * MultiEdit is not in every build's tool table; it is read the same way
 * where it is.
 */
const EDIT_PATH_ARGUMENT = new Map([
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
])

/** The file an edit tool's call names, or undefined for any other tool, or a call that names none. */
export const editedPathOf = (tool: string, input: object): string | undefined => {
  const argument = EDIT_PATH_ARGUMENT.get(tool)
  const value = argument === undefined ? undefined : (input as Record<string, unknown>)[argument]

  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Whether a call's answer says the file was written: not refused, not an
 * error, and not held for the machine owner's review (`staged`), which
 * leaves the file as it was.
 */
export const editLanded = (answer: object): boolean => {
  const { deny, isError, result } = answer as { deny?: unknown; isError?: unknown; result?: unknown }
  if (deny !== undefined || isError === true) return false

  return !(typeof result === 'object' && result !== null && (result as { staged?: unknown }).staged === true)
}

// ---------------------------------------------------------------------------
// Hints: the paths a prompt names, where there is no scope
// ---------------------------------------------------------------------------

/** Where a prompt the person typed comes from: the terminal, or Remote Control. */
const PERSON_ORIGINS = new Set(['composer', 'bridge'])

/**
 * Whether a submitted prompt is the person's own words: typed, not a slash
 * command, and not one they do not see as typed (a task's notification, a
 * peer's message, a plugin's prompt).
 */
export const isPersonsPrompt = (prompt: { origin?: { kind: string }; command?: unknown; isMeta?: boolean }): boolean =>
  prompt.command === undefined && prompt.isMeta !== true && PERSON_ORIGINS.has(prompt.origin?.kind ?? '')

/**
 * The extensions a file name in a prompt may end in: code, docs, config and
 * data. A word with any other dot (`JSON.parse`, `console.log`) is not read
 * as a file, so a stray dot does not start a guess.
 */
const FILE_EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs mts cts json jsonc json5 md mdx txt rst adoc yml yaml toml ini cfg conf xml ' +
    'html htm css scss sass less vue svelte astro py pyi ipynb rb go rs java kt kts scala swift m mm c h ' +
    'cc cpp cxx hpp hh cs fs fsx php pl pm lua r jl dart ex exs erl elm clj cljs hs ml nim zig sol sql ' +
    'graphql gql proto sh bash zsh fish ps1 bat mk cmake gradle properties lock tf tfvars hcl csv tsv ' +
    'svg png jpg jpeg gif webp ico pdf wasm snap'
  ).split(' '),
)

/** Endings that make a slashed word a link rather than a folder: `github.com/org/repo`. */
const HOST = /\.(?:com|org|net|io|dev|app|ai|co|gov|edu)$/i

/** `e.g`, `i.e`, `a.m`: initials, not a file. */
const INITIALS = /^(?:\p{L}\.)+\p{L}$/u

/** `Next.js`, `Node.js`: a project's name, not a file. Slashed or backticked, a path still counts. */
const PROJECT_NAME = /^\p{Lu}\p{Ll}+\.js$/u

/** `.gitignore`, `.env`, `.github`: a dot, then a lowercase letter or a digit. `.NET` is not one. */
const DOTFILE = /^\.[\p{Ll}\p{N}][\p{L}\p{N}._-]*$/u

/** `*.snap`, `*.test.ts`: a glob over file names. Stars around a word are emphasis, not this. */
const NAME_GLOB = /^\*(?:\.[\p{L}\p{N}_-]+)+$/u

/** What a path a prompt names is made of, past an optional drive. */
const PATH_CHARACTERS = /^[\p{L}\p{N}._\-/+*?]+$/u

/** A backticked span, or a run of characters that no path in prose is cut by. */
const TOKEN = /`([^`\n]+)`|([^\s"'`()[\]{}<>,;|]+)/g

/** `retry.ts`, `README.md`: a known extension, and not initials, a version or a project's name. */
const isFileName = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  if (/^[\p{N}.]+$/u.test(name.slice(0, dot)) || INITIALS.test(name) || PROJECT_NAME.test(name)) return false

  return FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** A candidate with what surrounds a path in prose taken off: a mention's `@`, closing punctuation, a line. */
const trimToken = (raw: string, isQuoted: boolean): string => {
  const bare = toSlashes(raw.trim())
  const unmentioned = !isQuoted && bare.startsWith('@') ? bare.slice(1) : bare

  return unmentioned
    .replace(/[.,:;!?…]+$/u, '')
    .replace(/#L\d+(?:-L?\d+)?$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/[.,:;!?…]+$/u, '')
}

/** Whether a trimmed candidate reads as a path the person named: see `mentionsIn`. */
const isMention = (token: string, isQuoted: boolean): boolean => {
  const body = token.replace(/^[A-Za-z]:(?=\/)/, '')
  if (body === '' || /^[./]+$/.test(body) || body.startsWith('-') || body.includes('//')) return false
  if (!PATH_CHARACTERS.test(body)) return false
  const isGlob = /[*?]/.test(body)
  if (!body.includes('/')) return isGlob ? NAME_GLOB.test(body) : isFileName(body) || DOTFILE.test(body)
  const segments = body.split('/').filter(segment => segment !== '')
  if (!body.startsWith('/') && !body.startsWith('.') && HOST.test(segments[0] ?? '')) return false
  const last = segments.at(-1) ?? ''

  return (
    isGlob ||
    isQuoted ||
    body.endsWith('/') ||
    isFileName(last) ||
    DOTFILE.test(last) ||
    segments.length >= 3 ||
    (body.startsWith('/') && segments.length >= 2) ||
    body.startsWith('./') ||
    body.startsWith('../')
  )
}

/**
 * The paths a prompt names, trimmed, in the order written: a path with a
 * folder in it (`src/client/retry.ts`, `src/api/`, `packages/app/src`), a
 * file name with a known extension (`README.md`), a dotfile, or a glob
 * (`*.snap`, `src/**`). A backticked `lib/util` counts too. Prose with a
 * slash or a dot (`and/or`, `e.g.`, `v2.1`, `Next.js`), links, flags, slash
 * commands and calls (`res.json()`) do not: a stray one would turn every
 * edit of the turn into a guess.
 */
export const mentionsIn = (text: string): string[] => {
  const head = text.slice(0, MAX_PROMPT_CHARS)
  const found: string[] = []
  for (const match of head.matchAll(TOKEN)) {
    const [whole, quoted, plain = ''] = match
    const isQuoted = quoted !== undefined
    // A backticked command is not a path, and neither is a call: `res.json()`.
    if (isQuoted ? /\s/.test(quoted.trim()) : head[(match.index ?? 0) + whole.length] === '(') continue
    const token = trimToken(quoted ?? plain, isQuoted)
    if (isMention(token, isQuoted)) found.push(token)
  }

  return found
}

/** A slashed glob a prompt names, read from the project root. */
const promptGlob = (token: string, root: string): string => {
  const base = rootOf(root)
  const clean = token.replace(/^(?:\.\/)+/, '')

  return clean.startsWith(`${base}/`) ? clean.slice(base.length + 1) : clean
}

/** One mention as a hint: a glob, a bare name, or a path read against the project root. */
const hintOf = (token: string, root: string): Hint => {
  if (/[*?]/.test(token)) return { kind: 'glob', value: token.includes('/') ? promptGlob(token, root) : `**/${token}` }
  if (!token.includes('/')) return { kind: 'name', value: token }

  return { kind: 'path', value: projectPath(root, token.replace(/\/+$/, '')) }
}

/** Hints with each kept once, the first first, up to the cap. */
const mergeHints = (kept: readonly Hint[], more: readonly Hint[]): Hint[] => {
  const out = [...kept]
  for (const hint of more) {
    if (out.length >= MAX_HINTS) break
    if (!out.some(one => one.kind === hint.kind && one.value === hint.value)) out.push(hint)
  }

  return out
}

/** The hints a prompt gives, read against the project root. */
export const hintsFrom = (text: string, root: string): Hint[] =>
  mergeHints([], mentionsIn(text).map(token => hintOf(token, root)))

/**
 * Whether a hint covers an edited file: the file or folder it names, a bare
 * name anywhere in the path, or its glob.
 */
const hintCovers = (hint: Hint, path: string): boolean => {
  if (hint.kind === 'path') return path === hint.value || path.startsWith(`${hint.value}/`)
  if (hint.kind === 'name') return path.split('/').includes(hint.value)

  return globCovers(hint.value, path)
}

// ---------------------------------------------------------------------------
// One turn: its edits against its scope, or against its hints
// ---------------------------------------------------------------------------

/** What a turn's edits are held to: the person's globs, a guess from the prompt's paths, or nothing. */
export type Mode = 'scope' | 'guess' | 'none'

export const modeOf = (turn: ScopeTurn): Mode => {
  if (turn.scope.source !== 'none') return 'scope'

  return turn.hints.length > 0 ? 'guess' : 'none'
}

export type TurnStart = { turnId: string; root: string; scope: Scope; hints: readonly Hint[] }

/** A turn as it starts: nothing edited yet, so nothing to show. */
export const startTurn = (start: TurnStart): ScopeTurn => ({
  turnId: start.turnId,
  root: rootOf(start.root),
  scope: start.scope,
  hints: mergeHints([], start.hints),
  edited: [],
  isDone: false,
  isDismissed: false,
})

const isOutside = (turn: ScopeTurn, path: string): boolean => {
  const { scope } = turn
  if (scope.source !== 'none') return !inScope(path, scope.globs)

  return turn.hints.length > 0 && !turn.hints.some(hint => hintCovers(hint, path))
}

/** The files this turn edited outside its scope, or, with none, outside what its prompt named; first edit first. */
export const outsideOf = (turn: ScopeTurn): string[] => turn.edited.filter(path => isOutside(turn, path))

/**
 * One more landed edit. A file already listed stays where it was; a new file
 * outside brings a closed card back, since it is news Close never saw.
 */
export const withEdit = (turn: ScopeTurn, filePath: string): ScopeTurn => {
  const path = projectPath(turn.root, filePath)
  if (path === '' || turn.edited.includes(path) || turn.edited.length >= MAX_EDITED) return turn
  const next = { ...turn, edited: [...turn.edited, path] }

  return isOutside(next, path) ? { ...next, isDismissed: false } : next
}

/** Paths the person typed while the turn ran, joined to its hints. */
export const withHints = (turn: ScopeTurn, hints: readonly Hint[]): ScopeTurn => ({
  ...turn,
  hints: mergeHints(turn.hints, hints),
})

/**
 * The status line: `N outside scope`, counting only files outside the
 * person's own globs. A guess never reaches it. Nothing outside, or a
 * closed card, clears it.
 */
export const statusLine = (turn: ScopeTurn): string | undefined => {
  if (turn.isDismissed || modeOf(turn) !== 'scope') return undefined
  const count = outsideOf(turn).length

  return count === 0 ? undefined : `${count} outside scope`
}

export type Card = {
  subtitle: string
  /** Each file outside, with `(guess)` beside it where no scope holds the turn. */
  rows: { path: string; hint: string }[]
  /** Files past the glance cap; the card says `N more files…` for this. */
  overflow: number
}

/** The card once the turn has ended, or null while it runs, once Close put it away, or with nothing outside. */
export const cardFor = (turn: ScopeTurn): Card | null => {
  if (!turn.isDone || turn.isDismissed) return null
  const outside = outsideOf(turn)
  if (outside.length === 0) return null
  const hint = modeOf(turn) === 'guess' ? GUESS : ''
  const shown = outside.slice(0, MAX_ROWS)

  return {
    subtitle: subtitleOf(turn.scope),
    rows: shown.map(path => ({ path, hint })),
    overflow: outside.length - shown.length,
  }
}

// ---------------------------------------------------------------------------
// The command and the settings row
// ---------------------------------------------------------------------------

/**
 * The `/config` row this plugin's `enabled` field answers to: a row's key is
 * `<plugin>.<field>`, and a working copy loaded with `--plugin-dir` may carry
 * a suffix on its name (`wait-scope@inline`).
 */
export const ENABLED_ROW = /^wait-scope(@[\w-]+)?\.enabled$/

/** The key `$.config.set` takes for `enabled`, read off the rows `$.config.list()` returns. */
export const enabledRowKey = (rows: readonly { key: string }[]): string =>
  rows.find(row => ENABLED_ROW.test(row.key))?.key ?? 'wait-scope.enabled'

const globCount = (count: number): string => `${count} glob${count === 1 ? '' : 's'}`

/**
 * What `/wait-scope` answers once it has turned the warning on: where the
 * scope comes from, read the way the next turn will read it, and the one
 * command that turns it off. The engine prints it as `wait-scope: on · …`,
 * so the line does not name the plugin again.
 */
export const turnedOnLine = (scope: Scope): string => {
  if (scope.source === 'none') {
    return 'on · no scope set, so the paths your prompt names are a guess · /wait-scope turns it off'
  }
  const from = scope.source === 'file' ? SCOPE_FILE : `the ${GLOBS_TITLE} setting`

  return `on · ${globCount(scope.globs.length)} from ${from} · /wait-scope turns it off`
}

/** What `/wait-scope` answers once the setting is off, and the two places that turn it back on. */
export const turnedOffLine = (): string =>
  `off · /wait-scope turns it back on · /plugin → wait-scope → ${ENABLED_TITLE}`

/**
 * The setting could not be written, but the warning is still off on this machine.
 *
 * `/wait-scope` is the way back on: the settings screen may still read as
 * on, because that write did not land.
 */
export const turnedOffLocallyLine = (reason: string): string =>
  `off · the setting did not change (${reason}) · kept off on this machine · /wait-scope turns it back on`

/** What `/wait-scope` answers when a turn-on was refused: nothing moved. */
export const toggleRefusedLine = (reason: string): string =>
  `still off · the setting did not change (${reason}) · /plugin → wait-scope → ${ENABLED_TITLE}`

// ---------------------------------------------------------------------------
// The row above the prompt
// ---------------------------------------------------------------------------

/**
 * The waitroom mods that draw into the row above the prompt, the one with
 * precedence first.
 *
 * The list `wait-changed`, `wait-ship` and `bet-on-your-agent` keep in
 * lockstep, with this card last. Theirs end at bet-on-your-agent, and a mod
 * they do not name is behind them, so their order and this one agree without
 * a change to theirs. While the card waits its turn, the status line already
 * carries the count.
 */
export const BAND_PRECEDENCE = ['wait-breathe', 'wait-changed', 'wait-ship', 'bet-on-your-agent', 'wait-scope'] as const

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
