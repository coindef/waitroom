/**
 * wait-shell's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/**
 * How a Bash call came back. `ran` finished; `error` came back as an error
 * (a non-zero exit, a refusal at the permission check); `stopped` was
 * interrupted; `background` was left running in the background.
 */
export type CommandOutcome = 'ran' | 'error' | 'stopped' | 'background'

/** One shell command a turn ran, as the list shows it. */
export type ShellCommand = {
  /** The tool call's id, so one call is one row. */
  id: string
  /**
   * The command on one line: line breaks shown as ` ↵ `, runs of spaces
   * folded, escape and control characters dropped, cut at 200 characters.
   */
  text: string
  outcome: CommandOutcome
}

/** One main-loop turn as wait-shell watches it, from its start until the next turn starts. */
export type ShellTurn = {
  turnId: string
  /** The newest commands, oldest first: at most the eight the list can show. */
  commands: readonly ShellCommand[]
  /** Every command the turn ran, listed or not: the status line's count. */
  total: number
  /**
   * The turn has ended: a call that starts after this joins it only from a
   * subagent. Kept here so a reloaded module knows the turn it is in.
   */
  isDone: boolean
  /** Close put the list and the count away until the next turn starts. */
  isDismissed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'wait-shell': {
      /**
       * The current main-loop turn, or the one that just ended: the commands
       * the status line counts and the list shows. Null before the first
       * turn, and while the mod is off.
       */
      turn: ShellTurn | null
    }
  }
}
