import type { EngineInterface, Register } from 'claude-code'

import {
  identityGap,
  isPersonsPrompt,
  noteFromStore,
  noteKey,
  onCommand,
  onPrompt,
  onStop,
  statusFor,
  toStored,
  type IdentityGap,
  type Note,
} from './anchor'

type Loaded = { gap: IdentityGap } | { key: string; note: Note | null }

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The project root and the host session id. Either one missing is a gap:
 * there is no shorter key to try, and nothing is read.
 */
const load = async ($: EngineInterface): Promise<Loaded> => {
  const root = await $.session.root().catch(() => undefined)
  const id = await $.session.id().catch(() => undefined)
  const gap = identityGap(root, id)
  if (gap !== undefined) return { gap }
  const key = await noteKey(asText(root), asText(id))
  if (key === undefined) return { gap: 'both' }
  const raw = await $.store.get(key).catch(() => undefined)

  return { key, note: noteFromStore(raw) }
}

/** One key, replaced or removed as a whole. Other sessions' keys are not read. */
const write = async ($: EngineInterface, key: string, note: Note | null): Promise<void> => {
  if (note === null) await $.store.delete(key)
  else await $.store.set(key, toStored(note))
  $.ui.status(statusFor(note))
}

const showStatus = async ($: EngineInterface): Promise<void> => {
  const found = await load($)
  $.ui.status('gap' in found ? undefined : statusFor(found.note))
}

export const register: Register = on => {
  /**
   * One reminder in flight for this load.
   *
   * Set before the first await, so two prompts that arrive together cannot both
   * pass the check. The flag lives on this `register` call, not the module, so
   * a second session's load does not borrow it. A new process starts clear.
   */
  let claiming = false

  const remind = async (
    $: EngineInterface,
    prompt: { origin?: { kind?: string }; command?: unknown; isMeta?: boolean },
  ): Promise<void> => {
    if (!isPersonsPrompt(prompt) || claiming) return
    claiming = true
    try {
      const found = await load($)
      if ('gap' in found || found.note === null) return
      const taken = onPrompt(found.note, true)
      if (taken.line === undefined || taken.note === null) return
      // A transcript line. It is not added to the prompt, so the model is not told.
      $.ui.log(taken.line)
      await write($, found.key, taken.note)
    } finally {
      claiming = false
    }
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'anchor',
        description: 'Leave a note for future you',
        argumentHint: "what you're doing · check: what to verify",
      })
    } catch {
      // The note can still load. The command is registered again on the next start.
    }
    try {
      await showStatus($)
    } catch {
      $.ui.status(undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * `/anchor` answers here and does not start a turn. The text it returns is
   * the reply, not a prompt. A missing session id or project root writes nothing.
   */
  on('command.run', { command: 'anchor' }, async ($, e) => {
    try {
      const found = await load($)
      if ('gap' in found) {
        $.ui.status(undefined)

        return { text: onCommand('', null, found.gap).text }
      }
      const outcome = onCommand(typeof e.args === 'string' ? e.args : '', found.note, undefined)
      if (outcome.persist) await write($, found.key, outcome.note)
      else $.ui.status(outcome.status)

      return { text: outcome.text }
    } catch {
      return { text: 'no note kept · the note could not be saved' }
    }
  })

  /**
   * Stop: the main loop's turn ended, including a turn you interrupted.
   * The note stays. The reminder waits for the next prompt you type.
   * A subagent's turn is not you leaving.
   */
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      if (e.agentId !== undefined) return done
      const found = await load($)
      if ('gap' in found || found.note === null) return done
      const armed = onStop(found.note, false)
      if (armed !== found.note && armed !== null) await write($, found.key, armed)
    } catch {
      // The turn's answer is already decided.
    }

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The first prompt after Stop. The prompt goes through unchanged. The
   * reminder is a log line, once, and a task notice does not spend it.
   */
  on('prompt.submit', async ($, e, next) => {
    try {
      await remind($, e)
    } catch {
      // The prompt still goes through.
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
