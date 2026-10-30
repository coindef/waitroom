/**
 * wait-scope's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/**
 * Where a turn's scope came from: the project's `.claude/wait-scope`, the
 * *Files in scope* setting, or neither. Only a scope with globs counts a file
 * as outside it.
 */
export type Scope = { source: 'file' | 'setting'; globs: readonly string[] } | { source: 'none' }

/**
 * A path the person's prompt named: a file or folder, a bare file name, or a
 * glob. Only ever a hint, read when the turn has no scope of its own.
 */
export type Hint = { kind: 'path' | 'name' | 'glob'; value: string }

/** One main-loop turn as wait-scope watches it, from its start until the next turn starts. */
export type ScopeTurn = {
  turnId: string
  /** The project root the turn's paths are read against, with forward slashes. */
  root: string
  /** The scope as the turn started. A change to the file mid-turn waits for the next turn. */
  scope: Scope
  /** What the person's prompts for this turn named. */
  hints: readonly Hint[]
  /**
   * Every file an edit tool wrote this turn, first edit first, each once:
   * relative to `root`, or absolute where it lies outside it.
   */
  edited: readonly string[]
  /** The turn has ended, so the card may show. */
  isDone: boolean
  /** Close put the card and the count away, until an edit adds another file outside. */
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'wait-scope': {
      /**
       * The current main-loop turn, or the one that just ended.
       *
       * Its edits are read against its scope (or, with none, its hints) to
       * draw the status line's count and the card. Null before the first
       * turn, and while the mod is off.
       */
      turn: ScopeTurn | null
    }
  }
}
