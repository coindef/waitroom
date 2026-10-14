/**
 * wait-review's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/** Where a hunk stands in the review queue. */
export type HunkStatus = 'pending' | 'ok' | 'flagged' | 'later' | 'sent'

/**
 * One reviewable hunk of the agent's own diff.
 *
 * `id` is content-addressed (path plus a hash of the hunk text), which is what
 * makes eager surfacing safe: when the agent rewrites the same region the id
 * changes, so the hunk returns to the queue as a new one rather than staying
 * marked reviewed.
 */
export type Hunk = {
  id: string
  /** Repository-relative path, as git printed it. */
  path: string
  /** The `@@ -a,b +c,d @@` line. */
  header: string
  /** Header and body joined: ready for `Code` with `format: 'diff'`. */
  text: string
  added: number
  removed: number
  status: HunkStatus
}

/** A file the agent wrote, and the turn it last wrote it in. */
export type Touch = { path: string; turn: number }

declare module 'claude-code' {
  interface PluginState {
    'wait-review': {
      hunks: Hunk[]
      touches: Touch[]
      turn: number
      busy: boolean
    }
  }
}
