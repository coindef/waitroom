/**
 * wait-secret's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/** One line a diff added, with its line number in the file as it is now. */
export type AddedLine = { line: number; text: string }

/** The lines a file's diff against HEAD adds, as one scan read them. Held only while the turn end reads it. */
export type FileAdds = { path: string; lines: readonly AddedLine[] }

/** A scan that ran, or a scan that could not (not a repository, git failed). */
export type TreeScan = { ok: true; files: readonly FileAdds[] } | { ok: false }

/**
 * The tree as `turn.start` read it, kept only until that turn ends: per file,
 * a digest of each line already added, never the line itself, so no key text
 * sits in the plugin's state.
 */
export type Baseline = {
  turnId: string
  ok: boolean
  seen: Readonly<Record<string, readonly string[]>>
}

/** One line that looks like a secret: where, the masked value, and a guess at what it is. Never the value itself. */
export type Hit = { path: string; line: number; masked: string; kind: string }

/** The list for the turn that just ended. Absent once dismissed, or with no hit. */
export type SecretCard = {
  turnId: string
  hits: readonly Hit[]
  /** Hits past the glance cap; the card says `N more…` for this. */
  overflow: number
}

declare module 'claude-code' {
  interface PluginState {
    'wait-secret': {
      /**
       * The added lines at the start of the current main-loop turn, so a key
       * that was already uncommitted before the turn does not read as the
       * turn's own. Null before the first turn, and while the mod is off.
       */
      baseline: Baseline | null
      /** The list up between turns, or null when this turn has nothing to show or it was dismissed. */
      card: SecretCard | null
    }
  }
}
