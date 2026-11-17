import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ActivePrompt, SessionCounts } from '../types'
import {
  type BreatheStore,
  canPrompt,
  enabledRowKey,
  keepHistory,
  messageAt,
  type PromptEvent,
  sessionSummaryLine,
  storeFrom,
  toggledLine,
  toggleRefusedLine,
  rowsKept,
  wholePositive,
} from './breathe'

const STORE_KEY = 'state'

const activePrompt = atom({ plugin: 'wait-breathe', key: 'activePrompt' } as const, null as ActivePrompt | null)
/**
 * What this session has shown and had taken, for its session-end line. Kept
 * in `$.state`, not counted off the store's history: that history is shared
 * by every session of the install and does not say which one showed what.
 */
const sessionCounts = atom(
  { plugin: 'wait-breathe', key: 'sessionCounts' } as const,
  { shown: 0, taken: 0 } as SessionCounts,
)
const drewThisSession = atom({ plugin: 'wait-breathe', key: 'drewThisSession' } as const, false as boolean)

type Config = { enabled: boolean; longTurnSeconds: number }

const emptyStore = (): BreatheStore => ({ rotation: 0, lastPromptAt: null, history: [] })

/**
 * The saved record, or undefined when the read itself fails.
 *
 * A missing key is an empty record: the first run. A value that is present
 * but not a record this mod wrote is the same empty record, expired, so the
 * next due nudge replaces it. One bad value cannot turn the nudges off for
 * good. A failed read is neither. Callers skip the write, and whatever is
 * already saved stays until a later read works.
 */
const loadStore = async ($: EngineInterface): Promise<BreatheStore | undefined> => {
  const read = await $.store.get(STORE_KEY).then(
    value => ({ value }),
    () => undefined,
  )
  if (read === undefined) return undefined
  if (read.value === undefined) return emptyStore()

  return storeFrom(read.value) ?? emptyStore()
}

/**
 * The one check a long turn gets: past the threshold, cooldown allowing, show it.
 *
 * `stillArmed` is asked after the reads and again after the write: a turn
 * that ended while this check was reading the store raises nothing and
 * spends no cooldown; one that ended while it was saving shows nothing.
 */
const fire = async ($: EngineInterface, turnId: string, stillArmed: () => boolean) => {
  const store = await loadStore($)
  // The read failed: show nothing. A nudge here could be the second inside ten
  // minutes, and writing would replace a record this read does not have.
  if (store === undefined) return
  const now = await $.clock.now()
  if (!canPrompt(store.lastPromptAt, now)) return
  if (!stillArmed()) return
  const message = messageAt(store.rotation)
  // Saved first, shown second. A nudge whose cooldown and rotation did not
  // land would show again, the same message, inside the ten minutes; a failed
  // write therefore shows nothing, and the next long turn tries again.
  const saved = await $.store.set(STORE_KEY, { ...store, rotation: store.rotation + 1, lastPromptAt: now }).then(
    () => true,
    () => false,
  )
  if (!saved) return
  // The write is a round trip of its own: a turn that ended during it shows
  // nothing. Its cooldown is already saved and stays, as for any raise.
  if (!stillArmed()) return
  await update($, activePrompt, () => ({ turnId, message, shownAt: now, takenAt: null }))
}

const takeBreak = async ($: EngineInterface, turnId: string) => {
  const now = await $.clock.now()
  await update($, activePrompt, current =>
    current && current.turnId === turnId ? { ...current, takenAt: now } : current,
  )
}

/**
 * Counts the turn's prompt, if it raised one, for this session, folds it into
 * the persisted history, and clears it. The clear always runs: a prompt left
 * in state would draw again from the first second of the next turn.
 */
const commitAndClear = async ($: EngineInterface, turnId: string) => {
  try {
    const current = await read($, activePrompt)
    if (current && current.turnId === turnId) {
      const taken = current.takenAt !== null
      await update($, sessionCounts, counts => ({
        shown: counts.shown + 1,
        taken: counts.taken + (taken ? 1 : 0),
      }))
      const store = await loadStore($)
      // A failed read skips the write. An unreadable value arrives empty, and
      // this write replaces it.
      if (store !== undefined) {
        const event: PromptEvent = { at: current.shownAt, taken }
        // A failed write loses this one history entry and nothing else: the
        // cooldown and rotation were saved when the nudge was raised.
        await $.store.set(STORE_KEY, { ...store, history: keepHistory(store.history, event) }).catch(() => undefined)
      }
    }
  } finally {
    await update($, activePrompt, () => null)
  }
}

/**
 * Whether anything can draw the band. A `-p` run, or an SDK host with no
 * client attached, draws nowhere: `$.session.surfaces()` is empty there. It
 * is asked per turn because a desktop or mobile client can attach later.
 *
 * Asked at turn.start only. At session.end even the REPL's terminal has
 * already detached and the answer is empty, so session.end goes by what the
 * turns saw (`drewThisSession`).
 *
 * Documented never to reject; if it does, the turn is treated as drawn.
 * The test harness has no default answer for it, so a test that does not
 * mock it takes this path.
 */
const drawsSomewhere = ($: EngineInterface): Promise<boolean> =>
  $.session.surfaces().then(
    surfaces => surfaces.length > 0,
    () => true,
  )

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
  /** The turn the pending timer belongs to; null once it is cancelled. */
  let armedTurn: string | null = null

  const cancelPending = () => {
    pending?.cancel()
    pending = null
    armedTurn = null
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'breathe',
      description: 'Turn the breathing nudges on or off',
    })
    // The session's counts are not reset here: session.start fires again on
    // every hot reload while $.state survives it. session.end resets them.

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
    // Nothing draws the band in a headless run, so a nudge there would only
    // spend the cooldown the person's own sessions share: no flag, no armed
    // turn, no timer.
    if (config.enabled && (await drawsSomewhere($))) {
      await update($, drewThisSession, () => true)
      const turnId = e.turnId
      armedTurn = turnId
      pending = $.clock.after(config.longTurnSeconds * 1000, () =>
        fire($, turnId, () => armedTurn === turnId).catch(() => undefined),
      )
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The turn has ended when this event is raised, so its timer stops here,
  // before the hooks beneath do their own end-of-turn work: a turn under the
  // threshold is never nudged while they finish.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    cancelPending()
    const done = await next(e)
    await commitAndClear($, e.turnId)

    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // A session none of whose turns had anywhere to draw (a -p run, an SDK
    // host with nothing attached) logs nothing, and no session reads the
    // store here. The counts are zeroed once read, so a session begun after
    // this one (a /clear in the same process) does not report them again.
    const drew = config.enabled && (await read($, drewThisSession))
    const counts = await read($, sessionCounts)
    await update($, sessionCounts, () => ({ shown: 0, taken: 0 }))
    if (drew && counts.shown > 0) $.ui.log(sessionSummaryLine(counts.shown, counts.taken))

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

  // 2.1.325 stacks every plugin's row and `next(e)` there names nobody.
  // Leaving rows out of AbovePromptList is how one mod yields. 2.1.319
  // does not raise this event; the hook above still reads `part.plugin`.
  // The 2.1.319 types have no AbovePromptList. On 2.1.325 its props are the
  // band's plus `rows`, so it is typed as the band here and `rows` added.
  on('ui.render', { component: 'AbovePromptList', plugin: '*' } as unknown as { component: 'AbovePrompt' }, ($, e, next) => {
    const props = e.props as typeof e.props & { readonly rows: readonly { plugin?: unknown; tree?: unknown }[] }
    const kept = rowsKept(props.rows, props.isWorking)
    if (kept.length === props.rows.length) return next(e)

    return next({ ...e, props: { ...props, rows: kept } as typeof e.props })
  }).catch(($, e, next) => next(e))
}
