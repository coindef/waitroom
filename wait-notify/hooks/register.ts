import type { EngineInterface, Register } from 'claude-code'

import { configPathOf, createNotifier, isPersonPrompt, type NotifyHost, notificationTypeOf } from './notify'

/** `~/.waitroom/notify.json`, or undefined with no `HOME`, no file, or one that cannot be read. */
const readConfig = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (home === undefined || home === '') return undefined

  return $.fs.read(configPathOf(home)).catch(() => undefined)
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

  /** A prompt you sent: you are back. A task notification or another session's message is not you. */
  on('prompt.submit', ($, e, next) => {
    if (isPersonPrompt(e.origin)) notifier.clear()

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
    if (!e.isAborted) await notifier.turnEnded(hostOf($))

    return done
  }).catch(($, e, next) => next(e))

  /** Exit, `/clear`, resume: a reminder from before would be stale. */
  on('session.end', ($, e, next) => {
    notifier.clear()

    return next(e)
  }).catch(($, e, next) => next(e))
}
