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

export type SessionStatusLike = { type: string }

/** Whether a turn is running, OpenCode's equivalent of Claude Code's `turn.start`/`turn.complete`. */
export const isBusy = (status: SessionStatusLike): boolean => status.type === 'busy'

export type ToolPartLike = {
  id: string
  tool: string
  state: { status: string; input?: Record<string, unknown> }
}

/**
 * The built-in tools that touch a file, confirmed against the shipped
 * `opencode` binary's own tool registry names (`tool/edit`, `tool/write`) and
 * the hook examples on https://opencode.ai/docs/tools, which check
 * `input.tool === "apply_patch"` for the one that does not take a path.
 *
 * `apply_patch` is deliberately left out: it edits by patch text covering
 * possibly several files rather than one `filePath` argument, and counting
 * those files needs parsing the patch, which this prototype does not do (see
 * the adapter's README).
 */
const FILE_TOOLS = new Set(['edit', 'write'])

/** The path a completed `edit`/`write` tool call touched, or undefined. */
export const filePathOf = (part: ToolPartLike): string | undefined => {
  if (part.state.status !== 'completed') return undefined
  if (!FILE_TOOLS.has(part.tool)) return undefined
  const path = part.state.input?.filePath

  return typeof path === 'string' ? path : undefined
}

/**
 * Whether a tool part just finished for the first time — the moment it
 * counts toward the bonus question's tool-call tally, the OpenCode
 * equivalent of the Claude Code mod's unfiltered `tool.call` hook (see
 * `hooks/register.tsx#noteToolCall`), which counts every tool call once,
 * whichever tool and whether or not it was denied.
 *
 * Deduped against `alreadyCounted` because a part can fire more than one
 * `message.part.updated` event at `'completed'` status.
 */
export const isNewCompletion = (part: ToolPartLike, alreadyCounted: ReadonlySet<string>): boolean =>
  part.state.status === 'completed' && !alreadyCounted.has(part.id)

export type TextPartLike = { type: string; text?: string }

/** A user message's text, its parts flattened onto one line. */
export const askFrom = (parts: readonly TextPartLike[]): string =>
  parts
    .filter((part): part is TextPartLike & { text: string } => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ')
