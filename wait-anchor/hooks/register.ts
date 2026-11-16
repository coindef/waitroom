import type { EngineInterface, Register } from 'claude-code'

import {
  identityGap,
  isPersonsPrompt,
  noteFromStore,
  noteKey,
  onCommand,
  onPrompt,
  onStop,
  parseAnchorCommand,
  statusFor,
  toStored,
  type IdentityGap,
  type Note,
} from './anchor'
import { enterStoreGate, stampStoreDone, stampStoreStart } from './store-barrier'

type Loaded = { gap: IdentityGap } | { key: string; note: Note | null } | { key: string; readError: true }

/**
 * A rejected store read. The host already puts this mod's name in front, so
 * these start at the words. Nothing was written, and a failed read cannot
 * promise the old note is still there.
 */
const READ_UNCHANGED = "couldn't read your note · nothing was changed · try /anchor again"
const READ_NOT_SAVED = "couldn't read your note · the new one wasn't saved · try again"
const READ_NOT_CLEARED = "couldn't read your note · nothing was cleared · try again"

/** The reply for a command that could not read. Show, and text that is not a note, say nothing changed. */
const readErrorText = (args: string): string => {
  const parsed = parseAnchorCommand(args)
  if (parsed.type === 'clear') return READ_NOT_CLEARED
  if (parsed.type === 'set') return READ_NOT_SAVED

  return READ_UNCHANGED
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The project root and the host session id. Either one missing is a gap:
 * there is no shorter key to try, and nothing is read.
 *
 * A rejected `$.store.get` is a read error. A missing key is an empty note.
 * Callers must not treat the error as empty: that would show "no note" and
 * could write over the note the store still holds.
 */
const load = async ($: EngineInterface): Promise<Loaded> => {
  const root = await $.session.root().catch(() => undefined)
  const id = await $.session.id().catch(() => undefined)
  const gap = identityGap(root, id)
  if (gap !== undefined) return { gap }
  const key = await noteKey(asText(root), asText(id))
  if (key === undefined) return { gap: 'both' }
  const read = await $.store.get(key).then(
    value => ({ value }),
    () => undefined,
  )
  if (read === undefined) return { key, readError: true }

  return { key, note: noteFromStore(read.value) }
}

/**
 * One key, replaced or removed as a whole. Other sessions' keys are not read.
 * A failed `set` or `delete` throws and leaves the previous value in place.
 * The test-only store barrier (see store-barrier.ts) may rendezvous first; it
 * is off unless both WAIT_ANCHOR_STORE_BARRIER and WAIT_ANCHOR_STORE_BARRIER_OK=1
 * are set. Never set those in production.
 */
const persistNote = async ($: EngineInterface, key: string, note: Note | null): Promise<void> => {
  const op = note === null ? 'delete' : 'set'
  const gate = await enterStoreGate($, op)
  // `start` is stamped immediately before the store call; `done` after it returns.
  await stampStoreStart($, gate, op)
  try {
    if (note === null) await $.store.delete(key)
    else await $.store.set(key, toStored(note))
  } finally {
    await stampStoreDone($, gate, op)
  }
}

/** Persist, then show the status line. The status call is not the save. */
const write = async ($: EngineInterface, key: string, note: Note | null): Promise<void> => {
  await persistNote($, key, note)
  $.ui.status(statusFor(note))
}

/**
 * Stop owns `awaitingReturn` only. The note from the earlier load is stale:
 * the store gate awaits before the write, and a `/anchor clear` or a newer
 * note can land there. Re-read after that gate and write the flag onto the
 * note stored now. A missing note stays missing. A newer goal and check stay.
 */
const armReturn = async ($: EngineInterface, key: string): Promise<void> => {
  const gate = await enterStoreGate($, 'set')
  await stampStoreStart($, gate, 'set')
  let armed: Note | undefined
  try {
    const read = await $.store.get(key).then(
      value => ({ value }),
      () => undefined,
    )
    if (read === undefined) return
    const latest = noteFromStore(read.value)
    if (latest === null || latest.awaitingReturn) return
    armed = { ...latest, awaitingReturn: true }
    await $.store.set(key, toStored(armed))
  } finally {
    await stampStoreDone($, gate, 'set')
  }
  if (armed !== undefined) $.ui.status(statusFor(armed))
}

const showStatus = async ($: EngineInterface): Promise<void> => {
  const found = await load($)
  if ('readError' in found) {
    $.ui.status(READ_UNCHANGED)

    return
  }
  $.ui.status('gap' in found ? undefined : statusFor(found.note))
}

type PromptLike = { origin?: { kind?: string }; command?: unknown; isMeta?: boolean }

/**
 * One in-flight reminder for a single `register` call.
 *
 * The object is created inside `register` and passed in. The function that
 * receives `$` stays at the top of this file, which is the only place the
 * hooks loader follows `$`. Two loads do not share the flag.
 */
type Claim = { current: boolean }

/**
 * The first prompt after Stop. Declared here, not inside `register`, because
 * `$` may only be passed to a top-level helper.
 */
const remind = async ($: EngineInterface, prompt: PromptLike, claim: Claim): Promise<void> => {
  if (!isPersonsPrompt(prompt) || claim.current) return
  claim.current = true
  try {
    const found = await load($)
    if ('gap' in found || 'readError' in found || found.note === null) return
    const taken = onPrompt(found.note, true)
    if (taken.line === undefined || taken.note === null) return
    // Save first. A failed set must not print the line and then show it again
    // on the next prompt. The log is not part of the saved state.
    await persistNote($, found.key, taken.note)
    $.ui.log(taken.line)
    $.ui.status(statusFor(taken.note))
  } finally {
    claim.current = false
  }
}

export const register: Register = on => {
  const claim: Claim = { current: false }

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
      if ('readError' in found) {
        $.ui.status(READ_UNCHANGED)

        return { text: readErrorText(typeof e.args === 'string' ? e.args : '') }
      }
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
      if ('gap' in found || 'readError' in found || found.note === null) return done
      const armed = onStop(found.note, false)
      // `armed` is the stale snapshot. armReturn re-reads and does not write it back.
      if (armed !== found.note && armed !== null) await armReturn($, found.key)
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
    await remind($, e, claim)

    return next(e)
  }).catch(async ($, e, next) => {
    // next.error is the HookFailure the engine already recorded. It is not a
    // function. Reading it and returning next(e) forwards the original prompt.
    // This does not rethrow, and it does not pass the failure out of the hook.
    const failure = next.error
    const message =
      typeof failure === 'object' && failure !== null && 'message' in failure
        ? String((failure as { message: unknown }).message)
        : 'unknown'
    // Diagnostic only when WAIT_ANCHOR_DEBUG=1. Never swallow without a read.
    const debug = await $.env.get('WAIT_ANCHOR_DEBUG').catch(() => undefined)
    if (typeof debug === 'string' && debug.trim() !== '') {
      const dir = debug.trim().replace(/[\\/]+$/, '')
      await $.fs.write(`${dir}/prompt-submit-catch.txt`, `${message}\n`).catch(() => undefined)
    }

    return next(e)
  })
}
