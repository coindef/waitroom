/**
 * OpenCode-shape helpers with no OpenCode types, so they run under Node's own
 * test runner the way `bet-on-your-agent/hooks/bet.ts` runs under
 * `claude plugin test`.
 *
 * Each type here is a minimal structural subset of the real SDK type (see
 * `@opencode-ai/sdk`'s `SessionStatus`, `ToolPart`, `TextPart`) — enough to
 * type-check the fields this module actually reads, and nothing that would
 * force a dependency on the SDK package just to run these tests.
 */

/**
 * `api.kv` is one flat key-value store shared by every installed OpenCode
 * TUI plugin, not a per-plugin namespace — confirmed by tracing the shipped
 * `opencode` binary itself (not just `@opencode-ai/plugin`'s types): the
 * per-plugin api object built for each loaded plugin (`BU0` in the compiled
 * TUI bundle) wraps `slots.register` with an id-prefixed key (`${pluginId}:${n}`)
 * but forwards `kv` straight through unwrapped (`kv: J.kv`) from the single
 * app-wide api object built once in `dw`. A bare key like `"turns"` could
 * therefore collide with another plugin's own key of the same name; this
 * constant exists so the key carries this plugin's id instead of a generic
 * word. See the adapter's README for how `api.kv`'s disk persistence itself
 * was confirmed the same way.
 */
export const TURNS_KV_KEY = 'bet-on-your-agent:turns'

export type SessionStatusLike = { type: string }

/** Whether a turn is running, OpenCode's equivalent of Claude Code's `turn.start`/`turn.complete`. */
export const isBusy = (status: SessionStatusLike): boolean => status.type === 'busy'

/**
 * A turn ends on idle. `retry` is the same turn — a provider backoff — and
 * must not close the bet or open a second one when `busy` comes back.
 */
export const endsTurn = (status: SessionStatusLike): boolean => status.type === 'idle'

export type StatusStep = 'start' | 'finish' | 'ignore'

/** What the session-status handler should do. `retry` while a bet is open is `ignore`. */
export const statusStep = (status: SessionStatusLike, tracking: boolean): StatusStep => {
  if (isBusy(status)) return tracking ? 'ignore' : 'start'
  if (!endsTurn(status) || !tracking) return 'ignore'

  return 'finish'
}

export type ToolPartLike = {
  id: string
  tool: string
  state: { status: string; input?: Record<string, unknown> }
}

/**
 * Tools whose input is one `filePath`. `apply_patch` is not one of them: its
 * paths sit in `patchText` (`pathsFromApplyPatch`). bash writes files without
 * naming them; those come from `session.diff` or a git scan.
 */
const FILE_TOOLS = new Set(['edit', 'write'])

const settled = (status: string): boolean => status === 'completed' || status === 'error'

/** The path a settled `edit`/`write` names, or undefined. Not used for `apply_patch`. */
export const filePathOf = (part: ToolPartLike): string | undefined => {
  if (!settled(part.state.status)) return undefined
  if (!FILE_TOOLS.has(part.tool)) return undefined
  const path = part.state.input?.filePath

  return typeof path === 'string' && path !== '' ? path : undefined
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/

/** Paths named by an `apply_patch` body (`*** Add File:`, `Update`, `Delete`, `Move to`). */
export const pathsFromApplyPatch = (patchText: string): string[] => {
  const found: string[] = []
  for (const line of patchText.split(/\r?\n/)) {
    const path = PATCH_PATH.exec(line)?.[1]
    if (path && !found.includes(path)) found.push(path)
  }

  return found
}

/** Paths a settled tool part names by itself. bash names none. */
export const pathsFromTool = (part: ToolPartLike): string[] => {
  if (!settled(part.state.status)) return []
  if (part.tool === 'apply_patch') {
    const text = part.state.input?.patchText

    return typeof text === 'string' ? pathsFromApplyPatch(text) : []
  }
  const path = filePathOf(part)

  return path === undefined ? [] : [path]
}

/** bash and `apply_patch` can write files the tool input does not list one-by-one. */
export const needsWorktreeScan = (part: ToolPartLike): boolean =>
  settled(part.state.status) && (part.tool === 'bash' || part.tool === 'apply_patch')

/** Paths in `scanNow` that were not already dirty at `baseline`. */
export const pathsSince = (baseline: readonly string[], now: readonly string[]): string[] => {
  const had = new Set(baseline)

  return now.filter(path => path !== '' && !had.has(path))
}

/** Append paths not already counted, keeping the newest 200. */
export const mergeTouched = (current: readonly string[], more: readonly string[], limit = 200): string[] => {
  const next = [...current]
  for (const path of more) {
    if (path !== '' && !next.includes(path)) next.push(path)
  }

  return next.slice(-limit)
}

/** `mergeTouched` of a git content-hash delta (`changedSince`). */
export const filesAfterMove = (files: readonly string[], moved: readonly string[]): string[] => mergeTouched(files, moved)

export type NotedPart = {
  type: string
  id?: string
  tool?: string
  files?: readonly string[]
  state?: { status: string; input?: Record<string, unknown> }
}

export type PartNote = {
  toolCalls: number
  files: string[]
  countId?: string
  /** True when this part may have written files the input does not name. */
  scan: boolean
}

const pathsFromPatchList = (files: readonly string[] | undefined): string[] => {
  if (!files) return []
  const found: string[] = []
  for (const file of files) {
    if (file !== '' && !found.includes(file)) found.push(file)
  }

  return found
}

/**
 * What one `message.part.updated` changes on the open bet.
 *
 * `scanNow` is `session.diff` when the host could read it. Paths new since
 * `baseline` are counted. When `scanNow` is omitted, `scan` stays true so the
 * caller can fall back to `git status`.
 */
export const notePart = (
  bet: { toolCalls: number; files: readonly string[] },
  part: NotedPart,
  alreadyCounted: ReadonlySet<string>,
  scanNow: readonly string[] | undefined,
  baseline: readonly string[] | undefined,
): PartNote | undefined => {
  if (part.type === 'patch') {
    const paths = pathsFromPatchList(part.files)
    if (paths.length === 0) return undefined

    return { toolCalls: bet.toolCalls, files: mergeTouched(bet.files, paths), scan: false }
  }
  if (part.type !== 'tool' || !part.id || !part.tool || !part.state) return undefined
  const tool: ToolPartLike = { id: part.id, tool: part.tool, state: part.state }
  const isNew = isNewCompletion(tool, alreadyCounted)
  const named = pathsFromTool(tool)
  const scan = needsWorktreeScan(tool)
  const fromScan = scan && scanNow !== undefined && baseline !== undefined ? pathsSince(baseline, scanNow) : []
  if (!isNew && named.length === 0 && fromScan.length === 0) return undefined

  return {
    toolCalls: isNew ? bet.toolCalls + 1 : bet.toolCalls,
    files: mergeTouched(bet.files, [...named, ...fromScan]),
    ...(isNew ? { countId: tool.id } : {}),
    scan,
  }
}

/**
 * Whether a tool part just left `pending` / `running` for the first time —
 * completed or error. That is when it counts toward the bonus question's
 * tool-call tally, the OpenCode equivalent of the Claude Code mod's
 * unfiltered `tool.call` hook (see `hooks/register.tsx#noteToolCall`), which
 * counts every tool call once, whichever tool and whether or not it was denied.
 *
 * Deduped against `alreadyCounted` because a part can fire more than one
 * `message.part.updated` event at the same settled status.
 */
export const isNewCompletion = (part: ToolPartLike, alreadyCounted: ReadonlySet<string>): boolean =>
  settled(part.state.status) && !alreadyCounted.has(part.id)

export type TextPartLike = { type: string; text?: string }

/** A user message's text, its parts flattened onto one line. */
export const askFrom = (parts: readonly TextPartLike[]): string =>
  parts
    .filter((part): part is TextPartLike & { text: string } => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ')
