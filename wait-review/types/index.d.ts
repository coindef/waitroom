/**
 * wait-review's state contract.
 *
 * Self-contained by design: no import, no reference. The hooks module imports
 * these types from '../types', and `claude plugin validate` holds every
 * $.state key the module names to what is declared here.
 */

/**
 * Where a hunk stands in the review queue.
 *
 * `dropped` is not `ok`: it means the person waved a whole file away without
 * reading it, and the counts keep the two apart rather than claiming credit.
 */
export type HunkStatus = 'pending' | 'ok' | 'flagged' | 'later' | 'sent' | 'dropped'

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
  /** First line of the hunk on the new side, so a file reads top to bottom. */
  start: number
  /** Header and body joined: ready for `Code` with `format: 'diff'`. */
  text: string
  added: number
  removed: number
  status: HunkStatus
  /**
   * Why the person flagged it, in their words; absent unless they wrote one.
   *
   * Optional on purpose: flagging stays one press, and the note is a second,
   * separate act for the times when the diff alone does not say what is wrong.
   */
  note?: string
}

/**
 * The last call the person made, kept so one press can take it back.
 *
 * A list because dropping a whole file changes every pending hunk in it at
 * once, each from whatever status it held; marking a single hunk is just a
 * list of one.
 */
export type Decision = {
  changes: { id: string; from: HunkStatus }[]
  /** `session` as it stood just before this decision, so undo reverses the combo and the counts too. */
  fromSession: SessionStats
}

/** How far into a long hunk the reader has paged, and which hunk that was. */
export type Page = { id: string; offset: number }

/**
 * Per-session review stats: the combo and the grade's inputs.
 *
 * Tracked as their own counters rather than read off `hunks`'s current
 * statuses, because a hunk leaves that array entirely once git no longer
 * reports it (reverted, committed away) — taking its history with it if
 * nothing else remembered that it was ever read.
 */
export type SessionStats = {
  /** Hunks individually decided — ok, flagged or later — this session, cumulative. */
  read: number
  /** Hunks ever flagged this session, cumulative; a subset of `read`. */
  flagged: number
  /** Hunks dropped in bulk by skipping a file this session, cumulative. */
  skipped: number
  /** The current run of individually-decided hunks, reset to 0 by a skip. */
  combo: number
  /** The longest `combo` reached this session. */
  longestCombo: number
}

/** The session grade: how much of what was presented actually got read. */
export type Grade = 'S' | 'A' | 'B' | 'C'

declare module 'claude-code' {
  interface PluginState {
    'wait-review': {
      hunks: Hunk[]
      busy: boolean
      /**
       * Hunk ids that already existed when the session started.
       *
       * The queue is the whole repository diff, because an agent may write a
       * file through any tool — a shell heredoc leaves no Edit call to watch.
       * These are what was already uncommitted before the agent touched
       * anything, so your own work in progress is never offered as its review.
       */
      preexisting: string[]
      /**
       * The commit the diff is taken against: HEAD as it stood when the session
       * started, not HEAD as it stands now.
       *
       * An agent commits on your behalf, often before you have read a line, and
       * against current HEAD that silently empties the queue of everything it
       * just committed. Null where there was no commit to anchor to.
       */
      base: string | null
      lastDecision: Decision | null
      /**
       * The hunk a note is being typed for, or null.
       *
       * A mode, because a focused Input takes the keys that would otherwise be
       * the review hotkeys: the note box is only up while it is wanted.
       */
      noting: string | null
      /** Paging through the current hunk; a different hunk starts at the top. */
      page: Page | null
      /**
       * Whether `beginSession` has already run this session.
       *
       * `base` cannot serve as that flag: in a repository with no commits yet
       * it stays null forever, which reads the same as "never began".
       */
      began: boolean
      /**
       * Untracked, reviewable files the last scan found past the scan cap.
       *
       * The pane says so rather than silently dropping them, so a repository
       * with more new files than the cap does not look like it was fully read
       * when it was not.
       */
      truncatedFiles: number
      /**
       * This session's combo and grade inputs. Absent in a state file written
       * before this existed; `atom`'s own default fills it in, the same way a
       * fresh install gets one.
       */
      session: SessionStats
    }
  }
}
