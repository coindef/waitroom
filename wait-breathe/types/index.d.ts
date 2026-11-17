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

/** Nudges shown and taken in this session, for the session-end line. */
export type SessionCounts = {
  shown: number
  taken: number
}

declare module 'claude-code' {
  interface PluginState {
    'wait-breathe': {
      activePrompt: ActivePrompt | null
      /**
       * Nudges this session showed and had taken, counted as each turn ends.
       * The session-end line reads them, then zeroes them.
       */
      sessionCounts: SessionCounts
      /**
       * Whether a turn in this session had a surface to draw the band on.
       * False all through a `-p` run or an SDK host with nothing attached;
       * session.end logs its line only when this is true.
       */
      drewThisSession: boolean
    }
  }
}
