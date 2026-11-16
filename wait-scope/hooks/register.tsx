import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scope, ScopeTurn } from '../types'
import type { ScopeFileRead } from './scope'
import {
  cardFor,
  chooseScope,
  DISABLE_LABEL,
  DISMISS_LABEL,
  drawnBy,
  rowsKept,
  editedPathOf,
  editLanded,
  enabledRowKey,
  hintsFrom,
  isPersonsPrompt,
  overflowLine,
  resolveScope,
  SCOPE_FILE,
  startTurn,
  statusLine,
  TITLE,
  toggleRefusedLine,
  turnedOffLine,
  turnedOffLocallyLine,
  turnedOnLine,
  turnedOnUnreadLine,
  withEdit,
  withHints,
  yieldsBand,
} from './scope'

/** `$.store` key for a disable the settings write could not persist. */
const DISABLED_KEY = 'disabled'

const turn = atom({ plugin: 'wait-scope', key: 'turn' } as const, null as ScopeTurn | null)

/** The session's project root, or undefined where the engine cannot say. */
const projectRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const root = await $.session.root().catch(() => undefined)

  return typeof root === 'string' && root.trim() !== '' ? root : undefined
}

/**
 * The project's scope file.
 *
 * `unreadable` means the check or the read failed. A missing file is
 * `missing`. A caller must not treat `unreadable` as no file: that would
 * drop the project's scope for the turn.
 */
const readScopeFile = async ($: EngineInterface, root: string): Promise<ScopeFileRead> => {
  const path = `${root.replace(/[\\/]+$/, '')}/${SCOPE_FILE}`
  const exists = await $.fs.exists(path).then(
    value => ({ value }),
    () => undefined,
  )
  if (exists === undefined) return { kind: 'unreadable' }
  if (exists.value !== true) return { kind: 'missing' }
  const read = await $.fs.read(path).then(
    value => ({ value }),
    () => undefined,
  )
  if (read === undefined || typeof read.value !== 'string') return { kind: 'unreadable' }

  return { kind: 'text', text: read.value }
}

const setEnabled = async ($: EngineInterface, want: boolean): Promise<{ deny?: string }> => {
  const rows = await $.config.list().catch(() => [])

  return $.config
    .set({ key: enabledRowKey(rows), value: want })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
}

/**
 * Whether the warning is allowed to show. `enabled` is the settings field;
 * `locallyOff` is the copy `$.store` keeps when that write was refused.
 * Both reset when the module loads, which is also what a hot reload does.
 */
let enabled = true
let locallyOff = false
let prefLoaded = false
let prefLoading: Promise<void> | null = null
/** The *Files in scope* setting, as this load's options carry it. */
let settingGlobs = ''
/**
 * The latest prompt the person typed, kept for the turn it starts. A prompt
 * that is not theirs and starts a turn of its own clears it.
 */
let pendingPrompt: string | null = null
/** The last scope `.claude/wait-scope` actually parsed. A failed read keeps it. */
let lastFileScope: Scope | undefined
/** The unreadable line was already logged for this streak of failed reads. */
let unreadAnnounced = false

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

/**
 * The status line, a convenience: it never throws outward, because a failure
 * here would otherwise abort the hook that was keeping it up to date.
 */
const showStatus = async ($: EngineInterface) => {
  try {
    const now = silenced() ? null : await read($, turn)
    $.ui.status(now === null ? undefined : statusLine(now))
  } catch {
    // Nothing to do: the turn's record is still right, only unshown.
  }
}

/**
 * One edit tool's call, once it ran: a file it wrote joins the current turn
 * and the count is put back. A refused, failed or staged edit wrote nothing.
 */
const noteEdit = async ($: EngineInterface, path: string | undefined, ran: object) => {
  if (path === undefined || path.trim() === '' || !editLanded(ran)) return
  await ensurePref($)
  if (silenced() || (await read($, turn)) === null) return
  await update($, turn, now => (now === null ? now : withEdit(now, path)))
  await showStatus($)
}

/**
 * `noteEdit` after the tool has run. It never throws. The hook's `.catch`
 * would be safe anyway (a caught `next` replays the settled answer, nothing
 * beneath runs again), but a count is not worth a failed hook.
 */
const noteEditSafely = async ($: EngineInterface, path: string | undefined, ran: object) => {
  try {
    await noteEdit($, path, ran)
  } catch {
    // The edit landed and its answer goes back untouched; only the count is missed.
  }
}

/**
 * The scope a turn, or `/wait-scope`, reads now.
 *
 * A failed read keeps `lastFileScope` and names a notice. A real read
 * replaces that memory. The notice is not a scope: the command must not
 * answer as if no scope were set.
 */
const readTurnScope = async (
  $: EngineInterface,
  root: string,
): Promise<{ scope: Scope | undefined; notice: string | undefined }> => {
  const read = await readScopeFile($, root)
  const chosen = chooseScope(read, settingGlobs, lastFileScope)
  if (read.kind !== 'unreadable') {
    lastFileScope = chosen.remembered
    unreadAnnounced = false
  }

  return { scope: chosen.scope, notice: chosen.notice }
}

/** The scope `/wait-scope` reports: read now, the way the next turn start reads it. */
const currentScope = async ($: EngineInterface): Promise<Scope | 'unreadable'> => {
  const root = await projectRoot($)
  if (root === undefined) return resolveScope(undefined, settingGlobs)
  const { scope, notice } = await readTurnScope($, root)
  if (notice !== undefined) return 'unreadable'

  return scope ?? { source: 'none' }
}

/**
 * Permanent off. The settings field is the switch `/plugin` shows; when that
 * write is refused, a local preference keeps the warning silent anyway, and
 * `/wait-scope` is what turns that preference back off.
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

const enableWarning = async ($: EngineInterface): Promise<string | undefined> => {
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
  settingGlobs = typeof options.globs === 'string' ? options.globs : ''
  locallyOff = false
  prefLoaded = false
  prefLoading = null
  pendingPrompt = null
  lastFileScope = undefined
  unreadAnnounced = false

  on('session.start', async ($, e, next) => {
    await ensurePref($)
    await $.command.register({
      name: 'wait-scope',
      description: 'Turn the out-of-scope warning on or off',
    })
    // A reload keeps the turn's record: put its count back, or clear it when off.
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * One command, on or off: `/wait-scope` flips the same `enabled` setting
   * the install screen and `/plugin` show, and says where the scope comes
   * from once it is on. Turning off also sticks when that write is refused,
   * because Don't show again promised the warning would stay gone. Turning on
   * clears that local preference, which is the way back when the settings
   * screen never moved.
   */
  on('command.run', { command: 'wait-scope' }, async $ => {
    await ensurePref($)
    if (silenced()) {
      const reason = await enableWarning($)
      if (reason !== undefined) return { text: toggleRefusedLine(reason) }
      const scope = await currentScope($)

      return { text: scope === 'unreadable' ? turnedOnUnreadLine() : turnedOnLine(scope) }
    }
    const reason = await silenceForever($)

    return { text: reason === undefined ? turnedOffLine() : turnedOffLocallyLine(reason) }
  })

  /**
   * The paths a prompt names, read only as a hint for a turn with no scope.
   * Only what the person typed counts. Kept before `next`, which resolves
   * once the turn it starts has started. A prompt typed while a turn runs
   * joins that turn's hints, and is kept for a turn of its own as well.
   * Never refused, never rewritten.
   */
  // Pre-`next` hooks: anything thrown before `next` falls to `.catch -> next(e)`,
  // which runs what is beneath once; a caught `next` replays, never reruns.
  on('prompt.submit', async ($, e, next) => {
    const isTyped = isPersonsPrompt(e)
    if (isTyped) pendingPrompt = e.text
    else if (e.turnId === undefined) pendingPrompt = null
    if (isTyped && e.turnId !== undefined) {
      await ensurePref($)
      const running = silenced() ? null : await read($, turn)
      if (running !== null && running.turnId === e.turnId && !running.isDone) {
        await update($, turn, now =>
          now !== null && now.turnId === e.turnId ? withHints(now, hintsFrom(e.text, now.root)) : now,
        )
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const prompt = pendingPrompt ?? ''
    pendingPrompt = null
    // The previous turn's count and card belong to it. Gone before this turn
    // paints, so a wait never opens on last turn's list.
    $.ui.status(undefined)
    await ensurePref($)
    if (silenced()) {
      await update($, turn, () => null)

      return next(e)
    }
    const root = await projectRoot($)
    if (root === undefined) {
      await update($, turn, () => null)

      return next(e)
    }
    const { scope, notice } = await readTurnScope($, root)
    if (notice !== undefined && !unreadAnnounced) {
      unreadAnnounced = true
      $.ui.log(notice)
    }
    await update($, turn, () =>
      scope === undefined ? null : startTurn({ turnId: e.turnId, root, scope, hints: hintsFrom(prompt, root) }),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * Post tool use, for each tool that writes a file: the tool runs first and
   * its answer goes back untouched, whatever it was. A subagent's edit counts
   * toward the main turn it runs in.
   */
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await noteEditSafely($, e.file_path, ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await noteEditSafely($, e.file_path, ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    await noteEditSafely($, e.notebook_path, ran)

    return ran
  }).catch(($, e, next) => next(e))

  // MultiEdit is not in every build's tool table, so it is matched by pattern
  // and its path read the way any edit's is.
  on('tool.call', { tool: /^MultiEdit$/ }, async ($, e, next) => {
    const ran = await next(e)
    await noteEditSafely($, editedPathOf('MultiEdit', e), ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
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
   * The card rides the row above the prompt — under the transcript, not over
   * it, and not a modal. It is drawn only once the turn has finished
   * (`isWorking` is false), and only when the turn edited a file outside its
   * scope, or, with none, outside what its prompt named.
   *
   * The row shows one mod at a time, and this card comes last: a breathe
   * nudge, a ship offer and the bet's question all keep
   * the row ahead of it. The status line carries the count meanwhile.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await ensurePref($)
    if (silenced() || e.props.hasSurvey || e.props.isWorking) return next(e)
    const showing = await read($, turn)
    const card = showing === null ? null : cardFor(showing)
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
              after the file list has taken the rows beneath them. */}
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
          {card.subtitle}
        </Text>
        {card.rows.map(row => (
          <Box key={row.path} justifyContent="space-between" gap={2}>
            <Text wrap="truncate-start">{row.path}</Text>
            {row.hint !== '' && (
              <Box flexShrink={0}>
                <Text dimColor>{row.hint}</Text>
              </Box>
            )}
          </Box>
        ))}
        {card.overflow > 0 && <Text dimColor>{overflowLine(card.overflow)}</Text>}
      </Box>
    )
    const beneath = await next(e).catch(() => undefined)
    // `{ type: "engine" }` names nobody. Returning it would hide this card
    // even when the row is empty, so it is not a yield.
    return beneath !== undefined && yieldsBand('wait-scope', drawnBy(beneath)) ? beneath : mine
  }).catch(($, e, next) => next(e))

  // 2.1.325 stacks every plugin's row and `next(e)` there names nobody.
  // Leaving rows out of AbovePromptList is how one mod yields. 2.1.319
  // does not raise this event; the hook above still reads `part.plugin`.
  on('ui.render', { component: 'AbovePromptList', plugin: '*' }, ($, e, next) => {
    const kept = rowsKept(e.props.rows, e.props.isWorking)
    if (kept.length === e.props.rows.length) return next(e)

    return next({ ...e, props: { ...e.props, rows: kept } })
  }).catch(($, e, next) => next(e))
}
