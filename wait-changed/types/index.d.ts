/**
 * wait-changed's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

export type FileKind = 'added' | 'modified' | 'deleted'

/** One file in a read-only `git diff`, plus a digest of its changed lines. */
export type FileStat = {
  path: string
  added: number
  removed: number
  kind: FileKind
  /**
   * Digest of the added and removed lines. Two scans with the same counts can
   * still be a different edit; the digest is what tells them apart.
   */
  digest: string
}

/** A scan that ran, or a scan that could not (not a repository, git failed). */
export type TreeScan = { ok: true; files: readonly FileStat[] } | { ok: false }

/** The tree as `turn.start` read it, kept only until that turn ends. */
export type Baseline = {
  turnId: string
  scan: TreeScan
}

/** The card for the turn that just ended. Absent once dismissed, or when there was nothing to show. */
export type DiffCard = {
  turnId: string
  rows: { path: string; hint: string }[]
  /** Files past the glance cap; the card says `还有 N 个文件…` for this. */
  overflow: number
}

declare module 'claude-code' {
  interface PluginState {
    'wait-changed': {
      /**
       * The working tree at the start of the current main-loop turn.
       *
       * The card is the difference between this and the tree at `turn.complete`,
       * so dirt that was already there before the turn does not read as the
       * turn's own. Null before the first turn, and after a turn the mod is
       * not watching.
       */
      baseline: Baseline | null
      /** The card up between turns, or null when this turn has nothing to show or it was dismissed. */
      card: DiffCard | null
    }
  }
}
