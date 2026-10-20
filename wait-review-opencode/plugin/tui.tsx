/**
 * wait-review for OpenCode: the Claude Code mod's pane, ported as far as the
 * verified OpenCode plugin API allows.
 *
 * This file only type-checks against the real `@opencode-ai/plugin`,
 * `@opentui/core`, `@opentui/keymap` and `@opentui/solid` type declarations
 * (see the adapter's README for how it was checked); it has not been run
 * inside a live OpenCode TUI session, since doing so needs a configured model
 * provider this environment does not have. The engine-free scanning it calls
 * (`./scan.ts`) is the part that is actually tested — see `tests/scan.test.ts`.
 *
 * Why this is a `tui` plugin and not a `server` one: a server plugin's only
 * channel into the terminal is the SDK client's one-way `client.tui.*` calls
 * (`showToast`, `appendPrompt`, `executeCommand`, …) — none of them read
 * anything back. Only a `tui` plugin runs inside the terminal renderer
 * itself and gets a keymap to bind hotkeys on and slots to draw into. See the
 * README's "Can a plugin capture a keypress mid-turn?" section for the
 * evidence.
 *
 * Not yet ported, not blocked on the API: saying why a hunk is flagged, and
 * attaching flagged hunks to the next prompt. Both look reachable (a keymap
 * command can call `api.client.session.prompt` and OpenCode's `input`
 * element could take the note), they are just scoped out of this prototype.
 */

import { spawn } from 'node:child_process'

import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'

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
} from '../../wait-review/hooks/diff.ts'
import type { Hunk, HunkStatus } from '../../wait-review/types/index.ts'
import { currentHead, repoRoot, scanRepo, type GitResult, type GitRunner } from './scan.ts'

const runGit: GitRunner = (argv, cwd) =>
  new Promise(resolve => {
    const child = spawn('git', argv as string[], { cwd })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve({ stdout, exitCode: code ?? 1 } satisfies GitResult))
  })

type SessionState = {
  root: string | undefined
  anchor: string | null
  preexisting: string[]
  hunks: Hunk[]
  lastDecision: { id: string; from: HunkStatus } | null
  truncatedFiles: number
}

const freshState = (): SessionState => ({
  root: undefined,
  anchor: null,
  preexisting: [],
  hunks: [],
  lastDecision: null,
  truncatedFiles: 0,
})

export const tui: TuiPlugin = async api => {
  const config = { contextLines: 3, ignore: parseIgnore(DEFAULT_IGNORE) }

  // Keyed by session id, in memory only — the same lifetime as the Claude
  // Code mod's own `$.state`, which also does not survive a restart.
  const sessions = new Map<string, SessionState>()
  const seen = new Set<string>()

  const stateFor = (sessionID: string): SessionState => {
    const found = sessions.get(sessionID)
    if (found) return found
    const made = freshState()
    sessions.set(sessionID, made)

    return made
  }

  /**
   * The session the single-pane TUI is actually showing, the same role
   * `e.agentId === undefined` plays in the Claude Code mod: there is no
   * `session.start` event to take this from directly, so it is read off the
   * route instead.
   */
  const activeSessionId = (): string | undefined => {
    const route = api.route.current

    // `TuiRouteCurrent`'s third, generic variant (`{name: string, params?:
    // Record<string, unknown>}`) overlaps "session" too, so TypeScript will
    // not narrow `params.sessionID` to `string` from the tag check alone.
    return route.name === 'session' && typeof route.params?.sessionID === 'string'
      ? route.params.sessionID
      : undefined
  }

  /** First sight of a session: anchor it and snapshot what was already dirty. */
  const beginSession = async (sessionID: string) => {
    if (seen.has(sessionID)) return
    seen.add(sessionID)

    const state = stateFor(sessionID)
    const root = await repoRoot(runGit, api.state.path.worktree)
    state.root = root
    if (root === undefined) return

    state.anchor = await currentHead(runGit, root)
    const already = await scanRepo(runGit, root, state.anchor, config)
    state.preexisting = already.hunks.map(one => one.id)
  }

  const scan = async (sessionID: string) => {
    const state = stateFor(sessionID)
    if (state.root === undefined) return
    const found = await scanRepo(runGit, state.root, state.anchor, config)
    state.hunks = mergeHunks(state.hunks, reviewable(found.hunks, config.ignore, state.preexisting))
    state.truncatedFiles = found.truncatedFiles
  }

  const mark = (sessionID: string, id: string, status: HunkStatus) => {
    const state = stateFor(sessionID)
    const before = state.hunks.find(one => one.id === id)
    state.hunks = state.hunks.map(one => (one.id === id ? { ...one, status } : one))
    state.lastDecision = before ? { id, from: before.status } : null
  }

  const undo = (sessionID: string) => {
    const state = stateFor(sessionID)
    const last = state.lastDecision
    if (!last) return
    state.hunks = state.hunks.map(one => (one.id === last.id ? { ...one, status: last.from } : one))
    state.lastDecision = null
  }

  const dropFile = (sessionID: string, path: string) => {
    const state = stateFor(sessionID)
    state.hunks = state.hunks.map(one =>
      one.path === path && (one.status === 'pending' || one.status === 'later')
        ? { ...one, status: 'dropped' }
        : one,
    )
    state.lastDecision = null
  }

  // Subagents are separate child sessions in OpenCode (`client.session.children`),
  // not a flag on the same event the way Claude Code's `turn.complete` carries
  // `agentId`. Reacting only to session ids this plugin has itself begun
  // tracking has the same effect: a subagent's own session is never one of
  // those, because nothing here ever opens its route.
  api.lifecycle.onDispose(
    api.event.on('session.idle', async ({ properties }) => {
      if (!seen.has(properties.sessionID)) return
      await scan(properties.sessionID)
    }),
  )

  api.lifecycle.onDispose(
    api.event.on('session.status', async ({ properties }) => {
      if (properties.status.type !== 'busy') return
      await beginSession(properties.sessionID)
    }),
  )

  const currentHunk = (sessionID: string): Hunk | undefined => nextHunk(stateFor(sessionID).hunks)

  /** Runs `act` on the current hunk of the active session, if there is one. */
  const onCurrentHunk = (act: (sessionID: string, hunk: Hunk) => void): boolean => {
    const sessionID = activeSessionId()
    const hunk = sessionID ? currentHunk(sessionID) : undefined
    if (!sessionID || !hunk) return false
    act(sessionID, hunk)

    return true
  }

  const dispose = api.keymap.registerLayer({
    bindings: [
      { key: 'o', cmd: 'wait-review.ok' },
      { key: 'f', cmd: 'wait-review.flag' },
      { key: 'l', cmd: 'wait-review.later' },
      { key: 'x', cmd: 'wait-review.drop-file' },
      { key: 'u', cmd: 'wait-review.undo' },
    ],
    commands: [
      { name: 'wait-review.ok', run: () => onCurrentHunk((sessionID, hunk) => mark(sessionID, hunk.id, 'ok')) },
      {
        name: 'wait-review.flag',
        run: () => onCurrentHunk((sessionID, hunk) => mark(sessionID, hunk.id, 'flagged')),
      },
      {
        name: 'wait-review.later',
        run: () => onCurrentHunk((sessionID, hunk) => mark(sessionID, hunk.id, 'later')),
      },
      {
        name: 'wait-review.drop-file',
        run: () => onCurrentHunk((sessionID, hunk) => dropFile(sessionID, hunk.path)),
      },
      {
        name: 'wait-review.undo',
        run: () => {
          const sessionID = activeSessionId()
          if (!sessionID) return false
          undo(sessionID)
        },
      },
    ],
  })
  api.lifecycle.onDispose(dispose)

  // The pane's equivalent surface: a slot the host already keys by session,
  // so no route-tracking of our own is needed to know which session a given
  // render is for (see `TuiHostSlotMap.sidebar_content` in `@opencode-ai/plugin/tui`).
  api.slots.register({
    slots: {
      sidebar_content: (_ctx, props: { session_id: string }) => {
        const state = stateFor(props.session_id)
        const hunk = currentHunk(props.session_id)
        const counts = tally(state.hunks)
        const summary = summaryOf(state.hunks)
        const truncatedNote = state.truncatedFiles > 0 ? ` +${state.truncatedFiles} more files not shown` : ''

        if (!hunk) {
          return (
            <box flexDirection="column">
              <text>{summary === '' ? 'wait-review: nothing to read' : summary}</text>
              <text>{truncatedNote}</text>
            </box>
          )
        }

        const where = progressOf(state.hunks, hunk)
        const shown = trimHunk(hunk.text, 30)

        return (
          <box flexDirection="column">
            <text>
              {hunk.path} · file {where.atFile} of {where.ofFiles} · {where.totalLeft} left
            </text>
            <diff source={shown.text} />
            <text>o: ok  f: flag  l: later  x: skip file  u: undo</text>
            {counts.flagged > 0 && <text>{counts.flagged} flagged</text>}
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule = { id: 'wait-review', tui }

export default plugin
