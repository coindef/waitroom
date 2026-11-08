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

/** How long two store writes may wait for each other inside the hook. */
const BARRIER_WAIT_MS = 30_000

/**
 * Set only for `demo/real-store-race.sh`. Empty in normal use, so a note
 * writes straight through. The directory is a rendezvous, not the note store.
 */
const barrierRoot = async ($: EngineInterface): Promise<string | undefined> => {
  const raw = await $.env.get('WAIT_ANCHOR_STORE_BARRIER').catch(() => undefined)
  if (typeof raw !== 'string') return undefined
  const dir = raw.trim().replace(/[\\/]+$/, '')

  return dir === '' ? undefined : dir
}

const sessionFileId = async ($: EngineInterface): Promise<string> => {
  const id = await $.session.id().catch(() => undefined)
  if (typeof id !== 'string' || id.trim() === '') throw new Error('wait-anchor: store barrier has no session id')

  return id.trim()
}

const stampGate = async (
  $: EngineInterface,
  dir: string,
  kind: 'arrive' | 'release' | 'done',
  sid: string,
  op: 'set' | 'delete',
): Promise<void> => {
  const now = await $.clock.now()
  await $.fs.write(`${dir}/${kind}-${sid}`, `${op} ${now}\n`)
}

/** Both writes must have arrived before either one calls `$.store`. */
const waitForPeer = async ($: EngineInterface, dir: string): Promise<void> => {
  const deadline = (await $.clock.now()) + BARRIER_WAIT_MS
  while (true) {
    const listed = await $.fs.list(dir)
    let arrivals = 0
    if (Array.isArray(listed)) {
      for (const row of listed) {
        const name = typeof row === 'object' && row !== null && 'name' in row ? row.name : undefined
        if (typeof name === 'string' && name.startsWith('arrive-')) arrivals += 1
      }
    }
    if (arrivals >= 2) return
    if ((await $.clock.now()) >= deadline) {
      throw new Error('wait-anchor: store barrier timed out before both writes arrived')
    }
    await $.clock.sleep(50)
  }
}

/**
 * When the barrier directory is set, record arrival, wait until the other
 * write has arrived, then record release. The `$.store` call comes after this
 * returns. Unset, this returns immediately.
 */
const enterStoreGate = async ($: EngineInterface, op: 'set' | 'delete'): Promise<string | undefined> => {
  const dir = await barrierRoot($)
  if (dir === undefined) return undefined
  const sid = await sessionFileId($)
  await stampGate($, dir, 'arrive', sid, op)
  await waitForPeer($, dir)
  await stampGate($, dir, 'release', sid, op)

  return dir
}

const leaveStoreGate = async ($: EngineInterface, dir: string | undefined, op: 'set' | 'delete'): Promise<void> => {
  if (dir === undefined) return
  await stampGate($, dir, 'done', await sessionFileId($), op)
}

/**
 * One key, replaced or removed as a whole. Other sessions' keys are not read.
 * A failed `set` or `delete` throws and leaves the previous value in place.
 */
const persistNote = async ($: EngineInterface, key: string, note: Note | null): Promise<void> => {
  const op = note === null ? 'delete' : 'set'
  const gate = await enterStoreGate($, op)
  if (note === null) await $.store.delete(key)
  else await $.store.set(key, toStored(note))
  await leaveStoreGate($, gate, op)
}

/** Persist, then show the status line. The status call is not the save. */
const write = async ($: EngineInterface, key: string, note: Note | null): Promise<void> => {
  await persistNote($, key, note)
  $.ui.status(statusFor(note))
}

const showStatus = async ($: EngineInterface): Promise<void> => {
  const found = await load($)
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
    if ('gap' in found || found.note === null) return
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
    await remind($, e, claim)

    return next(e)
  }).catch(($, e, next) => {
    // Record the failure, then forward the original prompt. This does not rethrow.
    next.error('wait-anchor: the return line was not saved')

    return next(e)
  })
}
