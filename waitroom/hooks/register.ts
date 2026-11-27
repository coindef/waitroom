import type { EngineInterface, Register } from 'claude-code'

import {
  doctorReport,
  INSTALL_LIST_UNREADABLE,
  installedPluginsPath,
  USAGE,
} from './doctor'
import { FIRST_SESSION_TIP, shouldShowTip, TIP_SHOWN_KEY } from './tip'

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const readInstallText = async ($: EngineInterface): Promise<string | 'missing' | 'unreadable'> => {
  const path = installedPluginsPath({
    CLAUDE_CODE_PLUGIN_CACHE_DIR: asText(
      await $.env.get('CLAUDE_CODE_PLUGIN_CACHE_DIR').catch(() => undefined),
    ),
    CLAUDE_CONFIG_DIR: asText(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)),
    HOME: asText(await $.env.get('HOME').catch(() => undefined)),
    CLAUDE_CODE_USE_COWORK_PLUGINS: asText(
      await $.env.get('CLAUDE_CODE_USE_COWORK_PLUGINS').catch(() => undefined),
    ),
  })
  if (path === undefined) return 'missing'
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : 'unreadable'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return message.includes('ENOENT') ? 'missing' : 'unreadable'
  }
}

const readClaudeVersion = async (
  $: EngineInterface,
): Promise<{ version: string; base?: string } | 'unreadable'> => {
  try {
    const session = await $.session.version()
    if (typeof session.version !== 'string' || session.version.length === 0) return 'unreadable'
    if (session.base !== undefined && typeof session.base !== 'string') {
      return { version: session.version }
    }

    return session
  } catch {
    return 'unreadable'
  }
}

export const register: Register = on => {
  /**
   * One quiet block in the transcript, the first interactive session only.
   *
   * The store is what makes "once" survive a new session and a reload:
   * `session.start` fires again when this module reloads, and `$.state` would
   * not. A non-interactive start neither logs nor spends the flag. There is
   * no pane and no row for the tip — the flag is set as the lines are
   * written, so the block does not return. `/waitroom doctor` is registered
   * here so it is listed by the first prompt.
   */
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'waitroom',
        description: 'Check that the installed rooms look healthy',
        argumentHint: 'doctor',
      })
    } catch {
      // The command is registered again on the next start.
    }

    const seen = await $.store.get(TIP_SHOWN_KEY).catch(() => undefined)
    if (shouldShowTip(e.isInteractive === true, seen)) {
      await $.store.set(TIP_SHOWN_KEY, true)
      for (const line of FIRST_SESSION_TIP) $.ui.log(line)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  /**
   * `/waitroom doctor` answers here and does not start a turn. The text it
   * returns is the reply. It only reads the installed-plugins list and the
   * Claude Code version, and it never writes the store or a file.
   */
  on('command.run', { command: 'waitroom' }, async ($, e) => {
    const args = typeof e.args === 'string' ? e.args.trim() : ''
    if (args !== 'doctor') return { text: USAGE }
    try {
      const installText = await readInstallText($)
      const session = await readClaudeVersion($)

      return { text: doctorReport(installText, session) }
    } catch {
      return { text: INSTALL_LIST_UNREADABLE }
    }
  })
}
