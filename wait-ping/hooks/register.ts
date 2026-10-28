import type { EngineInterface, Register } from 'claude-code'

import {
  enabledRowKey,
  isPermissionNotification,
  notificationTypeOf,
  type PingReason,
  type Platform,
  pingPlan,
  platformOfUname,
  shouldPing,
  thresholdSecondsOf,
  toggledOffLine,
  toggledOnLine,
  toggleRefusedLine,
} from './ping'

type Config = { enabled: boolean; sound: boolean; thresholdSeconds: number }

/** Local notification binaries return quickly. A hang must not hold the turn. */
const NOTIFY_TIMEOUT_MS = 5_000

/**
 * `uname` with no arguments. Its stdout is `Darwin` or `Linux`.
 *
 * Both helpers sit at the top of the module so a hook can pass `$` in and
 * the engine can still see `$.process.run`. The argv is the binary and its
 * arguments. No shell.
 */
const UNAME_TIMEOUT_MS = 2_000

const desktop = async ($: EngineInterface): Promise<Platform> => {
  const found = await $.process.run(['uname'], { timeoutMs: UNAME_TIMEOUT_MS }).catch(() => undefined)
  if (found === undefined || found.exitCode !== 0) return 'other'

  return platformOfUname(found.stdout)
}

const deliver = async (
  $: EngineInterface,
  config: Config,
  reason: PingReason,
  durationMs: number,
  aborted: boolean,
  subagent: boolean,
) => {
  const gate = {
    enabled: config.enabled,
    sound: config.sound,
    reason,
    durationMs,
    thresholdSeconds: config.thresholdSeconds,
    aborted,
    subagent,
  }
  // A short turn, an interrupted turn, and a disabled mod run nothing — not even `uname`.
  if (!shouldPing(gate)) return
  const argv = pingPlan({ ...gate, platform: await desktop($) })
  if (argv === null) return
  await $.process.run(argv.slice(), { timeoutMs: NOTIFY_TIMEOUT_MS }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const config: Config = {
    enabled: options.enabled !== false,
    // Sound stays off unless the setting says so. A missing field is off.
    sound: options.sound === true,
    thresholdSeconds: thresholdSecondsOf(options.thresholdSeconds),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wait-ping',
      description: 'Turn local notifications on or off',
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * One command, on or off: `/wait-ping` flips the same `enabled` setting the
   * install screen and `/plugin` show. Sound and the threshold stay where
   * they were. The engine reloads a plugin whose options change; the flip is
   * applied here as well, so it holds whether or not that reload has happened.
   */
  on('command.run', { command: 'wait-ping' }, async $ => {
    const want = !config.enabled
    const rows = await $.config.list().catch(() => [])
    const done = await $.config
      .set({ key: enabledRowKey(rows), value: want })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
    if (done.deny !== undefined) return { text: toggleRefusedLine(config.enabled, done.deny) }
    config.enabled = want

    return { text: want ? toggledOnLine(config.thresholdSeconds, config.sound) : toggledOffLine() }
  })

  /**
   * Stop, via the same turn-end hook the other mods use. `durationMs` is the
   * gate: a short turn, a turn the user interrupted, and a subagent's turn
   * produce no notification. `next` runs first so the turn finishes either way.
   */
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await deliver($, config, 'stop', e.durationMs, e.isAborted === true, e.agentId !== undefined)

    return done
  }).catch(($, e, next) => next(e))

  /**
   * A permission confirm that has been waiting. Claude Code sends
   * `permission_prompt` after that wait, and does not send it if you answer
   * first. Other notification types, including `idle_prompt`, are not this.
   */
  on('classic.Notification', async ($, e, next) => {
    const done = await next(e)
    if (!isPermissionNotification(notificationTypeOf(e))) return done
    await deliver($, config, 'permission', 0, false, false)

    return done
  }).catch(($, e, next) => next(e))
}
