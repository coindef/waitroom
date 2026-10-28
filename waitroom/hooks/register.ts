import type { Register } from 'claude-code'

import { FIRST_SESSION_TIP, shouldShowTip, TIP_SHOWN_KEY } from './tip'

export const register: Register = on => {
  /**
   * One quiet block in the transcript, the first interactive session only.
   *
   * The store is what makes "once" survive a new session and a reload:
   * `session.start` fires again when this module reloads, and `$.state` would
   * not. A non-interactive start neither logs nor spends the flag. There is
   * no pane, no row, and no dismiss control — the flag is set as the lines
   * are written, so the block does not return.
   */
  on('session.start', async ($, e, next) => {
    const seen = await $.store.get(TIP_SHOWN_KEY).catch(() => undefined)
    if (shouldShowTip(e.isInteractive === true, seen)) {
      await $.store.set(TIP_SHOWN_KEY, true)
      for (const line of FIRST_SESSION_TIP) $.ui.log(line)
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
