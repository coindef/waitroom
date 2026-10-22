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
}

export type ArtifactKind = 'commit' | 'pr' | 'changelog'

export type ShipMode = 'all' | ArtifactKind | 'edit' | 'skip'

/** What came of answering the band's prompt, shown once beside it. */
export type ShipResult = {
  turnId: string
  mode: ShipMode
  /** What was written, each a repository-relative path; empty for `skip`. */
  wrote: { kind: ArtifactKind; path: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'wait-ship': {
      /** The pending kit for the turn that just ended, or null once answered or superseded. */
      offer: ShipOffer | null
      /** The most recent answer, shown once beside the band's own next draw; cleared at the next turn. */
      lastResult: ShipResult | null
    }
  }
}
