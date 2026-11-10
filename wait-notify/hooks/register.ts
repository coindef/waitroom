import type { EngineInterface, Register } from 'claude-code'

import {
  configPathOf,
  createNotifier,
  isPersonPrompt,
  LIVE_PREFIX,
  liveKeyOf,
  liveRecordOf,
  type NotifyHost,
  notificationTypeOf,
  peersOf,
  sessionLabel,
} from './notify'

/** `~/.waitroom/notify.json`, or undefined with no `HOME`, no file, or one that cannot be read. */
const readConfig = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home === '') return undefined

  return $.fs.read(configPathOf(home)).catch(() => undefined)
}

/** The session id and project root as the host reports them. Either can be undefined: nothing is guessed. */
const identityOf = async ($: EngineInterface): Promise<{ id: unknown; root: unknown }> => ({
  id: await $.session.id().catch(() => undefined),
  root: await $.session.root().catch(() => undefined),
})

/**
 * Writes this session's record in the plugin store, `live/<session id>`: its
 * folder name, its parent folder's name when it has one, and the time now.
 * Nothing without both an id and a root. Returns the identity it read. Never
 * rejects.
 */
const touchLive = async ($: EngineInterface): Promise<{ id: unknown; root: unknown }> => {
  const self = await identityOf($)
  const record = liveRecordOf(self, await $.clock.now().catch(() => Date.now()))
  if (record !== undefined) await $.store.set(record.key, record.entry).catch(() => undefined)

  return self
}

/** Removes this session's record: the session ended, `/clear` included. Never rejects. */
const dropLive = async ($: EngineInterface): Promise<void> => {
  const key = liveKeyOf(await $.session.id().catch(() => undefined))
  if (key !== undefined) await $.store.delete(key).catch(() => undefined)
}

/**
 * The label for this session's title: refresh its own record, read the other
 * live sessions' records, remove the stale ones, and, when a live peer's
 * folder has the same name, add the parent folder's name, or a tag when that
 * is the same too. Undefined, for the plain title, without an id and a root,
 * or when the store cannot be read.
 */
const labelOf = async ($: EngineInterface): Promise<string | undefined> => {
  const self = await touchLive($)
  if (liveRecordOf(self, 0) === undefined) return undefined
  const own = liveKeyOf(self.id)
  const keys = await $.store.keys().catch(() => [] as string[])
  const records: { key: string; value: unknown }[] = []
  for (const key of keys) {
    if (key === own || !key.startsWith(LIVE_PREFIX)) continue
    records.push({ key, value: await $.store.get(key).catch(() => undefined) })
  }
  const { peers, stale } = peersOf(records, await $.clock.now().catch(() => Date.now()))
  for (const key of stale) await $.store.delete(key).catch(() => undefined)

  return sessionLabel(self, peers)
}

/**
 * The notifier's world, built from `$`: a command by argv with no shell, the
 * engine's clock for the reminder, and the config file under `HOME`.
 *
 * It sits at the top of the module and takes `$`, so `claude plugin validate`
 * can follow the calls in. A command that cannot start, or runs past its
 * timeout, answers undefined rather than rejecting, so nothing here fails the
 * event it rides on.
 */
const hostOf = ($: EngineInterface): NotifyHost => ({
  run: (argv, timeoutMs) => $.process.run(argv, { timeoutMs }).catch(() => undefined),
  after: (ms, fn) => $.clock.after(ms, () => void fn().catch(() => undefined)),
  readConfig: () => readConfig($),
  label: () => labelOf($).catch(() => undefined),
})

export const register: Register = on => {
  const notifier = createNotifier()

  /**
   * Claude Code's Notification hook: a permission dialog, or a question, that
   * has waited. `next` runs first, so the engine's own notification and every
   * settings hook go ahead as they would. Then the presence check, and a
   * native notification only when you are away.
   */
  on('classic.Notification', async ($, e, next) => {
    const done = await next(e)
    await notifier.notification(hostOf($), notificationTypeOf(e))

    return done
  }).catch(($, e, next) => next(e))

  /**
   * Every tool call, watched and never changed. Its start tells an
   * AskUserQuestion dialog from a permission dialog. Its start can't mark your
   * answer, because a call starts, PreToolUse included, before its dialog
   * opens. Its end, for a call that was already running when the notification
   * went out, means Claude has moved on: you answered.
   */
  on('tool.call', async ($, e, next) => {
    const stamp = notifier.toolStarted(e.tool)
    try {
      return await next(e)
    } finally {
      notifier.toolSettled(stamp, e.tool)
    }
  }).catch(($, e, next) => next(e))

  /** The session's record in the plugin store, so a same-name session elsewhere can tell the two apart. */
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await touchLive($)

    return done
  }).catch(($, e, next) => next(e))

  /**
   * A prompt you sent: you are back. A task notification or another session's
   * message is not you. It also refreshes the session's record, without holding
   * the prompt: after `/clear` the session runs on under a new id.
   */
  on('prompt.submit', ($, e, next) => {
    if (isPersonPrompt(e.origin)) {
      notifier.clear()
      void touchLive($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /** You answered an MCP server's question. */
  on('classic.ElicitationResult', ($, e, next) => {
    notifier.clear()

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * The main loop's turn ended, answered, interrupted or failed: nothing is
   * blocked any more. A subagent's turn end is not the main turn's. Then, for
   * a turn you did not interrupt, the stop notification, which is off unless
   * `notify_on_stop` is on.
   */
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    notifier.clear()
    await touchLive($)
    if (!e.isAborted) await notifier.turnEnded(hostOf($))

    return done
  }).catch(($, e, next) => next(e))

  /** Exit, `/clear`, resume: a reminder from before would be stale, and so would the session's record. */
  on('session.end', async ($, e, next) => {
    notifier.clear()
    await dropLive($)

    return next(e)
  }).catch(($, e, next) => next(e))
}
