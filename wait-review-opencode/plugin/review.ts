/**
 * The review session, with no OpenCode types, so the keymap, the pane, and
 * the first-turn snapshot can be tested without a TUI.
 *
 * The baseline is taken when this is created — plugin load — and not on the
 * first `busy`. A snapshot that starts after the turn has been told to write
 * files the turn's own hunks as pre-existing, and `reviewable` then hides
 * them. `idle` waits for that baseline instead of giving up while `root` is
 * still unset.
 */

import { createRoot } from 'solid-js'
import { createStore } from 'solid-js/store'
import {
  DEFAULT_IGNORE,
  mergeHunks,
  nextHunk,
  parseIgnore,
  progressOf,
  reviewable,
  summaryOf,
  tally,
  trimHunk,
} from '../src/vendor/wait-review/hooks/diff.ts'
import type { Hunk, HunkStatus } from '../src/vendor/wait-review/types/index.ts'
import { currentHead, repoRoot, scanRepo, type GitRunner, type ScanConfig } from './scan.ts'

type SessionState = {
  root: string | undefined
  anchor: string | null
  preexisting: string[]
  hunks: Hunk[]
  lastDecision: { id: string; from: HunkStatus } | null
  truncatedFiles: number
  baselined: boolean
}

type Baseline = {
  root: string | undefined
  anchor: string | null
  preexisting: string[]
}

const freshState = (): SessionState => ({
  root: undefined,
  anchor: null,
  preexisting: [],
  hunks: [],
  lastDecision: null,
  truncatedFiles: 0,
  baselined: false,
})

/** What the sidebar draws. `showing` is the hunk card; otherwise the summary. */
export type Pane =
  | { showing: false; summary: string; truncatedNote: string }
  | {
      showing: true
      path: string
      atFile: number
      ofFiles: number
      totalLeft: number
      text: string
      flagged: number
      truncatedNote: string
    }

export type ReviewCommand = 'ok' | 'flag' | 'later' | 'drop-file' | 'undo'

export type Review = {
  /** Resolves once the pre-turn snapshot has been stored. */
  ready: () => Promise<void>
  busy: (sessionID: string) => Promise<void>
  idle: (sessionID: string) => Promise<void>
  /**
   * The pane for `sessionID`. Reads the reactive store, so a Solid render
   * that calls this repaints when a scan or a key changes the queue.
   */
  pane: (sessionID: string) => Pane
  /**
   * True only while the active session's pane is actually showing a hunk.
   * OpenCode's keymap evaluates this on each key (`enabled` on the layer).
   */
  layerEnabled: () => boolean
  /**
   * `false` means the key was not handled and must reach OpenCode. `u` is
   * handled only when a hunk is showing and there is a decision to undo.
   */
  command: (name: ReviewCommand) => boolean
}

export type ReviewOptions = {
  run: GitRunner
  worktree: string
  activeSessionId: () => string | undefined
  config?: ScanConfig
}

const takeSnapshot = async (run: GitRunner, worktree: string, config: ScanConfig): Promise<Baseline> => {
  const root = await repoRoot(run, worktree)
  if (root === undefined) return { root: undefined, anchor: null, preexisting: [] }

  const anchor = await currentHead(run, root)
  const already = await scanRepo(run, root, anchor, config)

  return { root, anchor, preexisting: already.hunks.map(hunk => hunk.id) }
}

export const createReview = (options: ReviewOptions): Review => {
  const config = options.config ?? { contextLines: 3, ignore: parseIgnore(DEFAULT_IGNORE) }
  const [sessions, setSessions] = createRoot(() => createStore<Record<string, SessionState>>({}))
  const seen = new Set<string>()
  let baseline: Baseline | undefined

  // Started here, at creation, so the git read is the tree from before a
  // turn. `busy` only applies this result; it does not scan again.
  const baselinePromise: Promise<void> = takeSnapshot(options.run, options.worktree, config).then(snap => {
    baseline = snap
  })

  const ensure = (sessionID: string): void => {
    if (sessions[sessionID]) return
    setSessions(sessionID, freshState())
  }

  const applyBaseline = (sessionID: string): void => {
    if (!baseline) return
    const state = sessions[sessionID]
    if (!state || state.baselined) return
    setSessions(sessionID, {
      root: baseline.root,
      anchor: baseline.anchor,
      preexisting: baseline.preexisting,
      baselined: true,
    })
  }

  const scan = async (sessionID: string): Promise<void> => {
    const state = sessions[sessionID]
    if (!state || state.root === undefined) return
    const found = await scanRepo(options.run, state.root, state.anchor, config)
    const current = sessions[sessionID]
    if (!current) return
    setSessions(sessionID, {
      hunks: mergeHunks(current.hunks, reviewable(found.hunks, config.ignore, current.preexisting)),
      truncatedFiles: found.truncatedFiles,
    })
  }

  const mark = (sessionID: string, id: string, status: HunkStatus): void => {
    const state = sessions[sessionID]
    if (!state) return
    const before = state.hunks.find(one => one.id === id)
    setSessions(sessionID, {
      hunks: state.hunks.map(one => (one.id === id ? { ...one, status } : one)),
      lastDecision: before ? { id, from: before.status } : null,
    })
  }

  const undo = (sessionID: string): void => {
    const state = sessions[sessionID]
    const last = state?.lastDecision
    if (!state || !last) return
    setSessions(sessionID, {
      hunks: state.hunks.map(one => (one.id === last.id ? { ...one, status: last.from } : one)),
      lastDecision: null,
    })
  }

  const dropFile = (sessionID: string, path: string): void => {
    const state = sessions[sessionID]
    if (!state) return
    setSessions(sessionID, {
      hunks: state.hunks.map(one =>
        one.path === path && (one.status === 'pending' || one.status === 'later')
          ? { ...one, status: 'dropped' }
          : one,
      ),
      lastDecision: null,
    })
  }

  const pane = (sessionID: string): Pane => {
    const state = sessions[sessionID]
    const hunks = state?.hunks ?? []
    const truncatedNote = state && state.truncatedFiles > 0 ? ` +${state.truncatedFiles} more files not shown` : ''
    const hunk = nextHunk(hunks)
    if (!hunk) return { showing: false, summary: summaryOf(hunks), truncatedNote }

    const where = progressOf(hunks, hunk)
    return {
      showing: true,
      path: hunk.path,
      atFile: where.atFile,
      ofFiles: where.ofFiles,
      totalLeft: where.totalLeft,
      text: trimHunk(hunk.text, 30).text,
      flagged: tally(hunks).flagged,
      truncatedNote,
    }
  }

  const showingHunk = (): boolean => {
    const sessionID = options.activeSessionId()
    if (!sessionID) return false
    const state = sessions[sessionID]
    return state ? nextHunk(state.hunks) !== undefined : false
  }

  const command = (name: ReviewCommand): boolean => {
    const sessionID = options.activeSessionId()
    const state = sessionID ? sessions[sessionID] : undefined
    const hunk = state ? nextHunk(state.hunks) : undefined
    // No hunk on screen: every review key, including `u`, is not handled.
    if (!sessionID || !state || !hunk) return false
    if (name === 'undo') {
      if (!state.lastDecision) return false
      undo(sessionID)
      return true
    }
    if (name === 'ok') mark(sessionID, hunk.id, 'ok')
    else if (name === 'flag') mark(sessionID, hunk.id, 'flagged')
    else if (name === 'later') mark(sessionID, hunk.id, 'later')
    else dropFile(sessionID, hunk.path)
    return true
  }

  return {
    ready: () => baselinePromise,
    busy: async sessionID => {
      // Record the session before the await so an `idle` that arrives while
      // the baseline git is still running is not dropped as an unknown id.
      seen.add(sessionID)
      ensure(sessionID)
      await baselinePromise
      applyBaseline(sessionID)
    },
    idle: async sessionID => {
      if (!seen.has(sessionID)) return
      await baselinePromise
      applyBaseline(sessionID)
      await scan(sessionID)
    },
    pane,
    layerEnabled: showingHunk,
    command,
  }
}

/**
 * Key layer for the review pane. `target` + `targetMode: "focus"` makes
 * `@opentui/keymap` skip the layer unless that pane is the focused node, so
 * a prompt that still has focus receives every key. `enabled` is consulted
 * on each key by `registerEnabledFields` (OpenCode calls that from
 * `createDefaultOpenTuiKeymap`) and is on only while a hunk is showing. A
 * command that returns `false` is rejected and does not `preventDefault`,
 * so `u` still reaches the focused pane when there is nothing to undo.
 */
export const reviewLayer = <T extends object>(review: Review, options?: { target?: T; onLeave?: () => boolean }) => ({
  ...(options?.target ? { target: options.target, targetMode: 'focus' as const } : {}),
  // Above OpenCode's session layers (0, and 1 for a foreground task). Those
  // register when the session route mounts, which can be after this plugin,
  // and at equal priority the later layer wins — `esc` is session interrupt.
  // This layer is inactive unless the pane itself is focused.
  priority: 2,
  enabled: () => review.layerEnabled(),
  bindings: [
    { key: 'o', cmd: 'wait-review.ok' },
    { key: 'f', cmd: 'wait-review.flag' },
    { key: 'l', cmd: 'wait-review.later' },
    { key: 'x', cmd: 'wait-review.drop-file' },
    { key: 'u', cmd: 'wait-review.undo' },
    { key: 'escape', cmd: 'wait-review.leave' },
  ],
  commands: [
    { name: 'wait-review.ok', run: () => review.command('ok') },
    { name: 'wait-review.flag', run: () => review.command('flag') },
    { name: 'wait-review.later', run: () => review.command('later') },
    { name: 'wait-review.drop-file', run: () => review.command('drop-file') },
    { name: 'wait-review.undo', run: () => review.command('undo') },
    { name: 'wait-review.leave', run: () => options?.onLeave?.() ?? true },
  ],
})

/**
 * Palette entry that focuses the review pane. No key binding: while the
 * prompt is focused, every key has to pass through, including `o`/`f`/`l`/`x`/`u`.
 * `namespace: "palette"` is what OpenCode's command palette queries.
 */
export const reviewEnterLayer = (review: Review, enter: () => boolean) => ({
  enabled: () => review.layerEnabled(),
  commands: [
    {
      name: 'wait-review.enter',
      title: 'Review hunks',
      desc: 'Focus the review pane',
      category: 'Session',
      namespace: 'palette',
      run: () => enter(),
    },
  ],
})
