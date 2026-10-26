import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ActivePrompt } from '../types'
import {
  canPrompt,
  enabledRowKey,
  keepHistory,
  messageAt,
  type PromptEvent,
  sessionCountsOf,
  sessionSummaryLine,
  toggledLine,
  toggleRefusedLine,
  wholePositive,
} from './breathe'

const STORE_KEY = 'state'

type Store = { rotation: number; lastPromptAt: number | null; history: PromptEvent[] }

const EMPTY_STORE: Store = { rotation: 0, lastPromptAt: null, history: [] }

const activePrompt = atom({ plugin: 'wait-breathe', key: 'activePrompt' } as const, null as ActivePrompt | null)
const sessionStartedAt = atom(
  { plugin: 'wait-breathe', key: 'sessionStartedAt' } as const,
  null as number | null,
)

type Config = { enabled: boolean; longTurnSeconds: number }

const loadStore = async ($: EngineInterface): Promise<Store> => {
  const raw = await $.store.get(STORE_KEY).catch(() => undefined)

  return raw && typeof raw === 'object' ? { ...EMPTY_STORE, ...(raw as Partial<Store>) } : EMPTY_STORE
}

/** The one check a long turn gets: past the threshold, cooldown allowing, show it. */
const fire = async ($: EngineInterface, turnId: string) => {
  const store = await loadStore($)
  const now = await $.clock.now()
  if (!canPrompt(store.lastPromptAt, now)) return
  const message = messageAt(store.rotation)
  await update($, activePrompt, () => ({ turnId, message, shownAt: now, takenAt: null }))
  await $.store.set(STORE_KEY, { ...store, rotation: store.rotation + 1, lastPromptAt: now })
}

const takeBreak = async ($: EngineInterface, turnId: string) => {
  const now = await $.clock.now()
  await update($, activePrompt, current =>
    current && current.turnId === turnId ? { ...current, takenAt: now } : current,
  )
}

/** Folds the turn's prompt, if it raised one, into the persisted history and clears it. */
const commitAndClear = async ($: EngineInterface, turnId: string) => {
  const current = await read($, activePrompt)
  if (current && current.turnId === turnId) {
    const store = await loadStore($)
    const event: PromptEvent = { at: current.shownAt, taken: current.takenAt !== null }
    await $.store.set(STORE_KEY, { ...store, history: keepHistory(store.history, event) })
  }
  await update($, activePrompt, () => null)
}

export const register: Register = (on, options) => {
  const config: Config = {
    enabled: options.enabled === true,
    longTurnSeconds: wholePositive(options.longTurnSeconds, 90),
  }

  /**
   * The one pending threshold timer, this environment's own.
   *
   * A hot reload tears down this whole module, which cancels it along with
   * everything else it closed over; within one load, `turn.start` and
   * `turn.complete` share it to start and stop the one check a turn gets.
   */
  let pending: Timer | null = null

  const cancelPending = () => {
    pending?.cancel()
    pending = null
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'breathe',
      description: 'Turn the breathing nudges on or off',
    })
    // Guarded: session.start fires again on every hot reload while $.state
    // survives it, so an unconditional write would move "this session" to
    // whatever moment the reload happened rather than when it truly began.
    if ((await read($, sessionStartedAt)) === null) {
      const now = await $.clock.now()
      await update($, sessionStartedAt, () => now)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * One key, on or off: `/breathe` flips the same `enabled` setting the
   * install screen and `/plugin` show, so there is one switch, not two.
   *
   * The engine reloads a plugin whose options change; the flip is applied
   * here as well, so it holds from the next turn whether or not that reload
   * has happened yet. A turn already running is left as it was armed.
   */
  on('command.run', { command: 'breathe' }, async $ => {
    const want = !config.enabled
    const rows = await $.config.list().catch(() => [])
    const done = await $.config
      .set({ key: enabledRowKey(rows), value: want })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    if (done.deny !== undefined) return { text: toggleRefusedLine(config.enabled, done.deny) }
    config.enabled = want
    if (!want) cancelPending()

    return { text: toggledLine(want, config.longTurnSeconds) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    cancelPending()
    if (config.enabled) {
      pending = $.clock.after(config.longTurnSeconds * 1000, () => fire($, e.turnId))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    cancelPending()
    await commitAndClear($, e.turnId)

    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (config.enabled) {
      const store = await loadStore($)
      const counts = sessionCountsOf(store.history, await read($, sessionStartedAt))
      if (counts.shown > 0) $.ui.log(sessionSummaryLine(counts.shown, counts.taken))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * The nudge rides the same band the other mods use, so it costs no pane and
   * sits where a glance during a long wait already lands.
   *
   * The band shows one waitroom mod at a time, and the nudge comes first: a
   * bet question or a ship offer beneath gives way to it, so it draws without
   * asking what is there. They have the row back once it is taken, or once
   * the turn ends and it clears.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.enabled || e.props.hasSurvey || !e.props.isWorking) return next(e)
    const prompt = await read($, activePrompt)
    if (!prompt || prompt.takenAt !== null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    // The tag and the key keep their width, so a narrow band cuts the message
    // and never splits " breathe " or "b: Took it" across two lines.
    return (
      <Box gap={1}>
        <Box flexShrink={0}>
          <Text backgroundColor="subtle" color="inverseText" weight="bold">
            {' breathe '}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {prompt.message}
        </Text>
        <Box flexShrink={0}>
          <Button key="taken" hotkey="b" plain dimColor onPress={() => takeBreak($, prompt.turnId)}>
            Took it
          </Button>
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
