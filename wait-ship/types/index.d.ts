/**
 * wait-ship's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/** The kit drafted for one turn, held until the person answers the band's prompt. */
export type ShipOffer = {
  turnId: string
  commit: { subject: string; body: string[] }
  prBody: string
  /** Absent when there is no CHANGELOG.md, or `includeChangelog` is off. */
  changelogEntry?: string
  /**
   * Set once "More" was pressed: the row then offers each draft on its own
   * key (commit, PR, changelog, for editing) beside accept-all and skip,
   * which are all it offers until then.
   */
  isExpanded?: true
}

export type ArtifactKind = 'commit' | 'pr' | 'changelog'

export type ShipMode = 'all' | ArtifactKind | 'edit' | 'skip'

/** What came of answering the band's prompt; its receipt goes to the transcript. */
export type ShipResult = {
  turnId: string
  mode: ShipMode
  /** What was written, each the path the receipt prints; empty for `skip`. */
  wrote: { kind: ArtifactKind; path: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'wait-ship': {
      /** The pending kit for the turn that just ended, or null once answered or superseded. */
      offer: ShipOffer | null
      /**
       * The tree as the last scan read it — at session start, at the start
       * of a turn, and at each turn's end — or null before the first and
       * when a snapshot did not finish in time. `tree` is the whole diff;
       * `files` is each file's own chunk, so a kit names only the files that
       * moved during the turn. A string is the one fingerprint an older
       * build stored for the whole diff. A turn that leaves `tree` as it was
       * changed nothing and gets no kit. Unknown counts as moved.
       */
      lastSeen:
        | {
            tree: string
            files: Record<string, string>
          }
        | string
        | null
    }
  }
}
