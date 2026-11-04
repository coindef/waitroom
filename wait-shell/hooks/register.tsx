import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShellTurn } from '../types'
import type { BashCall, TurnMark } from './shell'
import {
  accepts,
  cardFor,
  commandFrom,
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  earlierLine,
  enabledRowKey,
  hintOf,
  markOf,
  rowLine,
  startTurn,
  statusLine,
  SUBTITLE,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  withCommand,
  yieldsBand,
} from './shell'

/** `$.store` key for a disable the settings write could not persist. */
const DISABLED_KEY = 'disabled'

const turn = atom({ plugin: 'wait-shell', key: 'turn' } as const, null as ShellTurn | null)

const setEnabled = async ($: EngineInterface, want: boolean): Promise<{ deny?: string }> => {
  const rows = await $.config.list().catch(() => [])

  return $.config
    .set({ key: enabledRowKey(rows), value: want })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
}

/**
 * Whether the list is allowed to appear. `enabled` is the settings field;
 * `locallyOff` is the copy `$.store` keeps when that write was refused.
 * Both reset when the module loads, which is also what a hot reload does.
 */
let enabled = true
let locallyOff = false
let prefLoaded = false
let prefLoading: Promise<void> | null = null
/**
 * The main-loop turn as the turn hooks last left it. A Bash call reads it
 * as it starts, before it runs, with no `$` call between the call and the
 * shell, and joins that turn: a call that started before a turn began is
 * never that turn's, wherever its answer lands.
 */
let current: TurnMark | null = null

const silenced = (): boolean => !enabled || locallyOff

const ensurePref = ($: EngineInterface): Promise<void> => {
  if (prefLoaded) return Promise.resolve()
  if (prefLoading === null) {
    prefLoading = $.store
      .get(DISABLED_KEY)
      .catch(() => undefined)
      .then(value => {
        locallyOff = value === true
        prefLoaded = true
      })
  }

  return prefLoading
}

/** The status line, from the turn's count. It never throws outward. */
const showStatus = async ($: EngineInterface) => {
  try {
    const now = silenced() ? null : await read($, turn)
    $.ui.status(now === null ? undefined : statusLine(now))
  } catch {
    // Nothing to do: the turn's record is still right, only unshown.
  }
}

type Call = BashCall & { agentId?: string }

/**
 * One Bash call, once its answer is back: the command joins the turn it
 * started in, and the count is put back. A call a hook refused never ran; a
 * call that started once that turn had ended joins it only from a subagent;
 * and a turn that has since given way to the next one takes nothing more.
 */
const noteCommand = async ($: EngineInterface, call: Call, answer: object, startedIn: TurnMark | null) => {
  if (startedIn === null || !accepts(startedIn, call.agentId)) return
  const command = commandFrom(call, answer)
  if (command === null) return
  await ensurePref($)
  if (silenced()) return
  const now = await read($, turn)
  if (now === null || now.turnId !== startedIn.turnId) return
  await update($, turn, last => (last !== null && last.turnId === startedIn.turnId ? withCommand(last, command) : last))
  await showStatus($)
}

/**
 * `noteCommand` after the tool has run. It never throws: the hook's `.catch`
 * would only replay the settled answer (nothing beneath runs again), but a
 * row is not worth a failed hook.
 */
const noteCommandSafely = async ($: EngineInterface, call: Call, answer: object, startedIn: TurnMark | null) => {
  try {
    await noteCommand($, call, answer, startedIn)
  } catch {
    // The command ran and its answer goes back untouched; only the row is missed.
  }
}

/**
 * Permanent off. The settings field is the switch `/plugin` shows; when that
 * write is refused, a local preference keeps the list silent anyway, and
 * `/wait-shell` is what turns that preference back off.
 */
const silenceForever = async ($: EngineInterface): Promise<string | undefined> => {
  await update($, turn, () => null)
  $.ui.status(undefined)
  const done = await setEnabled($, false)
  if (done.deny !== undefined) {
    locallyOff = true
    await $.store.set(DISABLED_KEY, true).catch(() => undefined)

    return done.deny
  }
  enabled = false
  locallyOff = false
  await $.store.set(DISABLED_KEY, false).catch(() => undefined)

  return undefined
}

const enableList = async ($: EngineInterface): Promise<string | undefined> => {
  const done = await setEnabled($, true)
  if (done.deny !== undefined) return done.deny
  enabled = true
  locallyOff = false
  await $.store.set(DISABLED_KEY, false).catch(() => undefined)

  return undefined
}

export const register: Register = (on, options) => {
  // A fresh load starts from this install's settings and reads the store
  // again. Resetting here covers a second register in the same process.
  enabled = options.enabled !== false
  locallyOff = false
  prefLoaded = false
  prefLoading = null
  current = null

  on('session.start', async ($, e, next) => {
    await ensurePref($)
    await $.command.register({
      name: 'wait-shell',
      description: 'Turn the shell command list on or off',
    })
    // A reload keeps the turn's record: take up its turn again, and put its
    // count back, or clear it when off.
    if (current === null) current = markOf(await read($, turn).catch(() => null))
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * One command, on or off: `/wait-shell` flips the same `enabled` setting
   * the install screen and `/plugin` show. Turning off also sticks when that
   * write is refused, because Don't show again promised the list would stay
   * gone. Turning on clears that local preference, which is the way back when
   * the settings screen never moved.
   */
  on('command.run', { command: 'wait-shell' }, async $ => {
    await ensurePref($)
    if (silenced()) {
      const reason = await enableList($)

      return { text: reason === undefined ? turnedOnLine() : toggleRefusedLine(reason) }
    }
    const reason = await silenceForever($)

    return { text: reason === undefined ? turnedOffLine() : turnedOffLocallyLine(reason) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    current = { turnId: e.turnId, isDone: false }
    // The previous turn's count and list belong to it. Gone before this turn
    // paints, so a wait never opens on last turn's commands.
    $.ui.status(undefined)
    await ensurePref($)
    await update($, turn, () => (silenced() ? null : startTurn(e.turnId)))

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * Post tool use, Bash only. The call goes down the chain as it came, and
   * its answer comes back as it went, whatever it was; only then is the
   * command noted, in the turn it started in. Nothing here refuses, rewrites
   * or reruns a call, and nothing waits on `$` before it runs. A subagent's
   * command counts toward the main turn it runs in.
   */
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedIn = current
    const ran = await next(e)
    await noteCommandSafely($, e, ran, startedIn)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Marked before `next`, so a call that starts from here on reads the turn as over.
    if (e.agentId === undefined && current !== null && current.turnId === e.turnId) {
      current = { ...current, isDone: true }
    }
    const done = await next(e)
    // `next` has run. The `.catch` below would replay its answer, not rerun
    // it, but bookkeeping failing should not fail the hook either.
    try {
      if (e.agentId !== undefined) return done
      await ensurePref($)
      if (silenced()) return done
      const now = await read($, turn)
      if (now !== null && now.turnId === e.turnId && !now.isDone) {
        await update($, turn, last => (last !== null && last.turnId === e.turnId ? { ...last, isDone: true } : last))
      }
    } catch {
      // Bookkeeping only: the turn's answer goes back as it was.
    }

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The list rides the row above the prompt, under the transcript and not a
   * modal, from the turn's first command until Close or the next turn: while
   * the turn runs, and after it ends.
   *
   * The row shows one mod at a time, and this list comes last: a breathe
   * nudge and the bet's forecast while a turn runs, and every other waitroom
   * card between turns, keep the row ahead of it. The status line carries
   * the count meanwhile.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await ensurePref($)
    if (silenced() || e.props.hasSurvey) return next(e)
    const showing = await read($, turn)
    const card = showing === null ? null : cardFor(showing, e.props.maxRows)
    if (showing === null || card === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const dismiss = async () => {
      await update($, turn, now => (now !== null && now.turnId === showing.turnId ? { ...now, isDismissed: true } : now))
      await showStatus($)
    }
    const mine = (
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={2}>
          <Text weight="bold" wrap="truncate-end">
            {TITLE}
          </Text>
          {/* On the title row, so a short band still offers both actions
              after the commands have taken the rows beneath them. */}
          <Box flexShrink={0} columnGap={2}>
            <Button key="dismiss" plain onPress={() => dismiss()}>
              {DISMISS_LABEL}
            </Button>
            <Button key="disable" plain dimColor onPress={() => void silenceForever($).catch(() => undefined)}>
              {DISABLE_LABEL}
            </Button>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {SUBTITLE}
        </Text>
        {card.earlier > 0 && <Text dimColor>{earlierLine(card.earlier)}</Text>}
        {card.rows.map(row => (
          <Box key={row.id} justifyContent="space-between" gap={2}>
            <Text wrap="truncate-end">{rowLine(row)}</Text>
            {hintOf(row.outcome) !== '' && (
              <Box flexShrink={0}>
                <Text dimColor>{hintOf(row.outcome)}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
    const beneath = await next(e).catch(() => undefined)

    return beneath !== undefined && yieldsBand('wait-shell', drawnBy(beneath)) ? beneath : mine
  }).catch(($, e, next) => next(e))
}
