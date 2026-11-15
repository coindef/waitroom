/**
 * wait-review for OpenCode: the Claude Code mod's pane, ported as far as the
 * verified OpenCode plugin API allows.
 *
 * Type-checked against the real `@opencode-ai/plugin`, `@opentui/core`,
 * `@opentui/keymap` and `@opentui/solid` declarations, and loaded once in
 * OpenCode 1.19.3's TUI (see the README). The engine-free parts it calls
 * (`./scan.ts`, `./review.ts`) are what the automated tests run.
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

import { createReview, reviewLayer } from './review.ts'
import type { GitResult, GitRunner } from './scan.ts'

const runGit: GitRunner = (argv, cwd) =>
  new Promise(resolve => {
    const child = spawn('git', argv as string[], { cwd })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve({ stdout, exitCode: code ?? 1 } satisfies GitResult))
  })

export const tui: TuiPlugin = async api => {
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

  // The snapshot starts now, before the handlers below can see a turn.
  const review = createReview({
    run: runGit,
    worktree: api.state.path.worktree,
    activeSessionId,
  })

  // Subagents are separate child sessions in OpenCode (`client.session.children`),
  // not a flag on the same event the way Claude Code's `turn.complete` carries
  // `agentId`. Reacting only to session ids this plugin has itself begun
  // tracking has the same effect: a subagent's own session is never one of
  // those, because nothing here ever opens its route.
  api.lifecycle.onDispose(
    api.event.on('session.idle', async ({ properties }) => {
      await review.idle(properties.sessionID)
    }),
  )

  api.lifecycle.onDispose(
    api.event.on('session.status', async ({ properties }) => {
      if (properties.status.type !== 'busy') return
      await review.busy(properties.sessionID)
    }),
  )

  const dispose = api.keymap.registerLayer(reviewLayer(review))
  api.lifecycle.onDispose(dispose)

  // The pane's equivalent surface: a slot the host already keys by session,
  // so no route-tracking of our own is needed to know which session a given
  // render is for (see `TuiHostSlotMap.sidebar_content` in `@opencode-ai/plugin/tui`).
  // `pane` reads the solid store, which is what makes a finished scan or a
  // keypress repaint this slot.
  api.slots.register({
    slots: {
      sidebar_content: (_ctx, props: { session_id: string }) => {
        const view = review.pane(props.session_id)

        if (!view.showing) {
          return (
            <box flexDirection="column">
              <text>{view.summary === '' ? 'wait-review: nothing to read' : view.summary}</text>
              <text>{view.truncatedNote}</text>
            </box>
          )
        }

        return (
          <box flexDirection="column">
            <text>
              {view.path} · file {view.atFile} of {view.ofFiles} · {view.totalLeft} left
            </text>
            <diff source={view.text} />
            <text>alt+o: ok · alt+f: flag · alt+l: later · alt+x: skip file · alt+u: undo</text>
            {view.flagged > 0 && <text>{view.flagged} flagged</text>}
          </box>
        )
      },
    },
  })

  await review.ready()
}

const plugin: TuiPluginModule = { id: 'wait-review', tui }

export default plugin
