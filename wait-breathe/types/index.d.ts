/**
 * wait-breathe's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/** The prompt currently showing in the band, if any. */
export type ActivePrompt = {
  /** The turn it was raised for; cleared when that turn ends. */
  turnId: string
  message: string
  /** When it was shown, `$.clock.now()`'s milliseconds — the history entry's own `at`. */
  shownAt: number
  /** When "took it" was pressed, or null while it still waits. */
  takenAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'wait-breathe': {
      activePrompt: ActivePrompt | null
      /**
       * When this session began, epoch milliseconds; null until `session.start`
       * has set it once. The session-end line counts from here.
       */
      sessionStartedAt: number | null
    }
  }
}
