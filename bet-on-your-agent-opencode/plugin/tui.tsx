/**
 * bet-on-your-agent for OpenCode: the Claude Code mod's row above the prompt,
 * ported as far as the verified OpenCode plugin API allows.
 *
 * This file type-checks against the real `@opencode-ai/plugin`,
 * `@opentui/core`, `@opentui/keymap` and `@opentui/solid` type declarations
 * (see the adapter's README for how) and has now been loaded in a real,
 * live OpenCode TUI session — this environment has no configured model
 * provider to drive a real turn, so that session was driven via a seeded
 * `api.kv` record and the Plugins dialog's install/activate flow rather than
 * an actual chat turn (see the README's "How this was verified"). `./track.ts`
 * is the part that is unit-tested.
 *
 * The central question this adapter answers: OpenCode has no analogue of
 * `client.tui.showToast` that reads anything back — every `client.tui.*` RPC
 * a *server* plugin can call is one-way. A *TUI* plugin, running inside the
 * terminal renderer itself, is a different surface: its `api.keymap` is the
 * real `@opentui/keymap` `Keymap` object (confirmed by installing
 * `@opentui/keymap` directly and reading `registerLayer` off it), which binds
 * real digit keys to real callbacks. That is what this plugin uses for the
 * band's bare-digit forecast, exactly like the Claude Code mod's hotkeys.
 *
 * Deliberately not ported — blocked on the API, not merely skipped:
 *
 * - **A verified, non-deprecated slash command.** `/bet` is wired up through
 *   `api.command`, but that whole surface is typed `@deprecated` in
 *   `@opencode-ai/plugin/tui`: "Legacy `api.command` API kept so v1 plugins
 *   can initialize. Remove in v2. Use `api.keymap.registerLayer`,
 *   `api.keymap.dispatchCommand`, and
 *   `api.keymap.dispatchCommand("command.palette.show")` instead." That
 *   replacement covers binding and invoking commands, but not naming a new
 *   one slash-invokable: `@opentui/keymap`'s own `Command` type is just
 *   `{name, run, [key: string]: unknown}`, with no `slash`/`slashName`
 *   semantics recognized anywhere in its matching logic. The shipped
 *   `opencode` binary's *own* built-in commands (e.g. `/sessions`, `/new`)
 *   do carry `slashName`/`slashAliases` fields, confirmed by grepping its
 *   compiled source — but those are an internal convention read by the
 *   app's own command palette, not part of any exported, typed contract a
 *   plugin can rely on. So this stays on `api.command`, best-effort against
 *   a surface the types say may disappear, rather than depending on an
 *   unexported convention that is just as likely to move without notice.
 *
 * Grounded by tracing the shipped `opencode` binary and then confirmed by
 * actually running it (see "How this was verified" below for the method):
 *
 * - **`api.kv` does persist across OpenCode process restarts.** The
 *   compiled binary's own KV provider reads and writes
 *   `path.join(<tui state dir>, "kv.json")` under a file lock on every
 *   `get`/`set`, hydrating from that file on startup (hence the `ready`
 *   flag). But it is one flat store shared by every installed TUI plugin,
 *   not namespaced per plugin the way `slots` is — see `track.ts`'s
 *   `TURNS_KV_KEY` for the fix applied here. Confirmed with a real two-process
 *   restart: one process set a sentinel under `TURNS_KV_KEY` and exited, a
 *   second fresh process read the same value back off disk.
 * - **`session_prompt_right` does land where intended, and shares its row
 *   with the host's own status text.** A live 60/70/80-column terminal
 *   showed that without a `maxWidth` cap, this slot's `<box>` and the host's
 *   own "Build · <model> OpenCode" status indicator fight over the same row:
 *   both wrap, and the host's own text — not just this slot's — comes out
 *   split one character per line and interleaved with this slot's content.
 *   `wrapMode="none"` on every `<text>` here plus `maxWidth="50%"` on every
 *   outer `<box>` (and the one bare `<text>` branch) fixes it: the host's
 *   status text now always renders intact, and this slot's own content
 *   truncates cleanly at the 50%-of-row boundary instead of interleaving.
 *   That boundary is a fixed fraction, not a real terminal-width query —
 *   `TuiSlotContext` (the `ctx` a slot callback receives) exposes only
 *   `theme`, no width, so there is no narrower API available to size this
 *   against the real column count.
 */

import type { BoxRenderable } from '@opentui/core'
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'

import {
  askRoomFor,
  asPercent,
  asText,
  BANDS,
  bonusBucketOf,
  bonusDimFor,
  bonusLabel,
  BONUS_BUCKETS,
  BONUS_QUESTIONS,
  bucketOf,
  currentRank,
  FILE_BUCKETS,
  filesPhrase,
  keepRecord,
  owedVerdict,
  changedSince,
  rankImproved,
  report,
  setVerdict,
  shortAsk,
  skipVerdict,
} from '../../bet-on-your-agent/hooks/bet.ts'
import type { BonusBucket, FileBucket, TurnRecord } from '../../bet-on-your-agent/types/index.ts'
import { createBandState } from './band.ts'
import { registerBetKeys } from './keys.ts'
import { noBet, type OpenBet } from './open-bet.ts'
import { askFrom, filesAfterMove, mergeTouched, notePart, pathsSince, statusStep } from './track.ts'
import { createTurnLog } from './turns.ts'
import { scanWorktree } from './worktree.ts'

export const tui: TuiPlugin = async api => {
  const band = createBandState()
  const tracking = new Set<string>()
  const toolCallsCounted = new Map<string, Set<string>>()
  const log = createTurnLog(api.kv, records => band.setTurns([...records]))
  // How many sessions have offered a bonus question so far; drives the
  // rotation the same way the Claude Code mod's `bonusRotation` atom does.
  let bonusRotation = 0

  const openFor = (sessionID: string): OpenBet => band.open[sessionID] ?? noBet()
  const setBet = (sessionID: string, bet: OpenBet) => {
    band.setOpen(sessionID, bet)
  }

  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const waitForKv = () => {
    if (log.flush()) return
    readyTimer = setTimeout(waitForKv, 25)
  }
  api.lifecycle.onDispose(() => {
    if (readyTimer !== undefined) clearTimeout(readyTimer)
  })
  waitForKv()

  const diffPaths = (sessionID: string): string[] | undefined => {
    try {
      return api.state.session.diff(sessionID).flatMap(row => (row.file !== '' ? [row.file] : []))
    } catch {
      return undefined
    }
  }

  const captureBaseline = (sessionID: string, turnId: string) => {
    void scanWorktree(api.state.path.worktree).then(look => {
      if (!look || !tracking.has(sessionID)) return
      const bet = openFor(sessionID)
      if (bet.turnId !== turnId) return
      setBet(sessionID, { ...bet, baselineLook: look, baseline: bet.baseline ?? Object.keys(look) })
    })
  }

  const askForTurn = async (sessionID: string): Promise<string> => {
    const messages = api.state.session.messages(sessionID)
    const last = [...messages].reverse().find(one => one.role === 'user')
    if (!last) return ''
    const parts = api.state.part(last.id)

    return askFrom(parts)
  }

  api.lifecycle.onDispose(
    api.event.on('session.status', async ({ properties }) => {
      const { sessionID, status } = properties
      const step = statusStep(status, tracking.has(sessionID))
      if (step === 'ignore') return
      if (step === 'start') {
        tracking.add(sessionID)
        const dim = bonusDimFor(bonusRotation)
        bonusRotation++
        const known = diffPaths(sessionID)
        const turnId = crypto.randomUUID()
        const bet: OpenBet = {
          ...noBet(),
          turnId,
          ask: await askForTurn(sessionID),
          startedAt: Date.now(),
          bonusDim: dim,
          ...(known === undefined ? {} : { baseline: known }),
        }
        setBet(sessionID, bet)
        if (known === undefined) captureBaseline(sessionID, turnId)
        // A new turn's own questions take over the slot; the last verdict is
        // settled by now, or it would still be the one being asked about.
        band.setLastVerdict(sessionID, undefined)

        return
      }

      tracking.delete(sessionID)
      const bet = openFor(sessionID)
      let touched = bet.files
      const finalDiff = diffPaths(sessionID)
      if (finalDiff !== undefined && bet.baseline !== undefined) {
        touched = mergeTouched(touched, pathsSince(bet.baseline, finalDiff))
      } else if (bet.baselineLook) {
        const look = await scanWorktree(api.state.path.worktree)
        if (look) touched = filesAfterMove(touched, changedSince(bet.baselineLook, look))
      }
      const files = touched.length
      const durationMs = Date.now() - bet.startedAt
      const bonusActual =
        bet.bonusDim === undefined
          ? undefined
          : bonusBucketOf(bet.bonusDim, bet.bonusDim === 'duration' ? durationMs : bet.bonusDim === 'files' ? files : bet.toolCalls)
      const record: TurnRecord = {
        turnId: bet.turnId,
        at: Date.now(),
        durationMs,
        files,
        filesBucket: bucketOf(files),
        toolCalls: bet.toolCalls,
        isAborted: false,
        ...(bet.ask === '' ? {} : { ask: shortAsk(bet.ask) }),
        ...(bet.saidConfidence !== undefined ? { saidConfidence: bet.saidConfidence } : {}),
        ...(bet.saidFiles !== undefined ? { saidFiles: bet.saidFiles } : {}),
        ...(bet.bonusDim === undefined ? {} : { bonusDim: bet.bonusDim }),
        ...(bet.saidBonus !== undefined ? { saidBonus: bet.saidBonus } : {}),
        ...(bonusActual === undefined ? {} : { bonusActual }),
      }
      log.update(records => keepRecord(records, record))
      setBet(sessionID, noBet())
      toolCallsCounted.delete(sessionID)
    }),
  )

  api.lifecycle.onDispose(
    api.event.on('message.part.updated', ({ properties }) => {
      const part = properties.part
      const sessionID = part.sessionID
      if (!tracking.has(sessionID)) return

      const bet = openFor(sessionID)
      const counted = toolCallsCounted.get(sessionID) ?? new Set<string>()
      // bash and apply_patch name no single filePath. session.diff is the
      // list of files touched; git status is the fallback when that read throws.
      const wantsScan = part.type === 'tool' && (part.tool === 'bash' || part.tool === 'apply_patch')
      const scanNow = wantsScan ? diffPaths(sessionID) : undefined
      const noted = notePart(bet, part, counted, scanNow, bet.baseline)
      if (!noted) return
      if (noted.countId) {
        counted.add(noted.countId)
        toolCallsCounted.set(sessionID, counted)
      }
      setBet(sessionID, { ...openFor(sessionID), toolCalls: noted.toolCalls, files: noted.files })
      if (!noted.scan || !noted.countId || scanNow !== undefined || !bet.baselineLook) return
      const turnId = bet.turnId
      void scanWorktree(api.state.path.worktree).then(look => {
        if (!look || !tracking.has(sessionID)) return
        const current = openFor(sessionID)
        if (current.turnId !== turnId || !current.baselineLook) return
        const files = filesAfterMove(current.files, changedSince(current.baselineLook, look))
        if (files.length === current.files.length && files.every((path, at) => path === current.files[at])) return
        setBet(sessionID, { ...current, files })
      })
    }),
  )

  const activeSessionId = (): string | undefined => {
    const route = api.route.current

    // `TuiRouteCurrent`'s third, generic variant (`{name: string, params?:
    // Record<string, unknown>}`) overlaps "session" too, so TypeScript will
    // not narrow `params.sessionID` to `string` from the tag check alone.
    return route.name === 'session' && typeof route.params?.sessionID === 'string'
      ? route.params.sessionID
      : undefined
  }

  const placeConfidence = (sessionID: string, said: number) => {
    setBet(sessionID, { ...openFor(sessionID), saidConfidence: said })
  }

  const placeFiles = (sessionID: string, said: FileBucket) => {
    setBet(sessionID, { ...openFor(sessionID), saidFiles: said })
  }

  const decline = (sessionID: string) => {
    setBet(sessionID, { ...openFor(sessionID), isDeclined: true })
  }

  const placeBonus = (sessionID: string, said: BonusBucket) => {
    setBet(sessionID, { ...openFor(sessionID), saidBonus: said })
  }

  const declineBonus = (sessionID: string) => {
    setBet(sessionID, { ...openFor(sessionID), isBonusDeclined: true })
  }

  const giveVerdict = (sessionID: string, turnId: string, landed: boolean) => {
    log.update(
      records => setVerdict(records, turnId, landed),
      (before, after) => {
        const fromRank = currentRank(before)
        const toRank = currentRank(after)
        band.setLastVerdict(sessionID, {
          result: landed ? 'landed' : 'fixed',
          ...(rankImproved(fromRank, toRank) ? { rankUp: { from: fromRank, to: toRank } } : {}),
        })
      },
    )
  }
  const waveVerdict = (sessionID: string, turnId: string) => {
    log.update(
      records => skipVerdict(records, turnId),
      () => band.setLastVerdict(sessionID, { result: 'skipped' }),
    )
  }

  // The bet row is focusable. A digit answers only while that row has focus.
  // The prompt keeps focus while you type, so the same key is a character there.
  const panels = new Map<string, BoxRenderable>()
  const panelFocused = (): boolean => {
    const sessionID = activeSessionId()
    const panel = sessionID ? panels.get(sessionID) : undefined
    if (!panel) return false
    let node = api.renderer.currentFocusedRenderable
    while (node) {
      if (node === panel) return true
      node = node.parent
    }

    return false
  }
  const rememberPanel = (sessionID: string) => (node: BoxRenderable | undefined) => {
    if (node) panels.set(sessionID, node)
    else panels.delete(sessionID)
  }

  api.lifecycle.onDispose(
    registerBetKeys(api.keymap, {
      sessionID: activeSessionId,
      bet: openFor,
      owedTurnId: () => owedVerdict(log.load())?.turnId,
      panelFocused,
      placeConfidence,
      placeFiles,
      decline,
      placeBonus,
      declineBonus,
      giveVerdict,
      waveVerdict,
    }),
  )

  // Legacy, typed `@deprecated` surface — see this file's header comment.
  // Kept anyway because it is the only typed way this package version offers
  // to answer to `/bet`; a non-deprecated replacement was not found.
  api.command?.register(() => [
    {
      title: 'Bet on your agent: your record',
      value: 'bet.report',
      slash: { name: 'bet' },
      onSelect: dialog => {
        const text = asText(report(log.load()))
        dialog?.replace(() => <box flexDirection="column">{text.split('\n').map(line => <text>{line}</text>)}</box>)
      },
    },
  ])

  api.slots.register({
    slots: {
      session_prompt_right: (_ctx, props: { session_id: string }) => {
        const sessionID = props.session_id
        // `view` reads the Solid store. A digit that writes the store reruns this slot.
        const { bet, owed, last } = band.view(sessionID)
        const room = askRoomFor(80)

        if (bet.turnId !== '' && bet.isDeclined !== true) {
          const quoted = shortAsk(bet.ask, room)
          const about = quoted === '' ? '' : ` "${quoted}"`

          if (bet.saidConfidence === undefined) {
            return (
              <box flexDirection="row" gap={2} maxWidth="50%" focusable ref={rememberPanel(sessionID)}>
                <text wrapMode="none">
                  Will{about} land first try?
                </text>
                {BANDS.map((band, at) => (
                  <text wrapMode="none">
                    {at + 1}: {asPercent(band)}
                  </text>
                ))}
                <text wrapMode="none">0: Skip</text>
              </box>
            )
          }

          if (bet.saidFiles === undefined) {
            return (
              <box flexDirection="row" gap={2} maxWidth="50%" focusable ref={rememberPanel(sessionID)}>
                <text wrapMode="none">
                  {asPercent(bet.saidConfidence)} · how many files?
                </text>
                {FILE_BUCKETS.map((bucket, at) => (
                  <text wrapMode="none">
                    {at + 1}: {bucket}
                  </text>
                ))}
                <text wrapMode="none">0: Skip</text>
              </box>
            )
          }

          // One rotating bonus question, its own skip: passing on it costs
          // nothing and says nothing about the confidence or files bets
          // already placed this turn. Mirrors the Claude Code mod's own
          // band; see `hooks/register.tsx`'s bonus branch.
          if (bet.bonusDim !== undefined && bet.saidBonus === undefined && bet.isBonusDeclined !== true) {
            const dim = bet.bonusDim
            const buckets = BONUS_BUCKETS[dim]

            return (
              <box flexDirection="row" gap={2} maxWidth="50%" focusable ref={rememberPanel(sessionID)}>
                <text wrapMode="none">
                  Bonus: {BONUS_QUESTIONS[dim]}
                </text>
                {buckets.map((bucket, at) => (
                  <text wrapMode="none">
                    {at + 1}: {bonusLabel(dim, bucket)}
                  </text>
                ))}
                <text wrapMode="none">0: Skip</text>
              </box>
            )
          }

          return (
            <text wrapMode="none" maxWidth="50%">
              bet {asPercent(bet.saidConfidence)} · {filesPhrase(bet.saidFiles)} · {bet.files.length} written so far
            </text>
          )
        }

        if (!owed) {
          if (!last) return <box />

          const label = last.result === 'landed' ? 'Landed' : last.result === 'fixed' ? 'Needed fixing' : 'Skipped'

          return (
            <box flexDirection="row" gap={1} maxWidth="50%">
              <text wrapMode="none">Recorded: {label}</text>
              {last.rankUp && (
                <text wrapMode="none">
                  Rank up: {last.rankUp.from} → {last.rankUp.to}
                </text>
              )}
            </box>
          )
        }

        const quoted = owed.ask === undefined ? '' : shortAsk(owed.ask, room)

        return (
          <box flexDirection="row" gap={2} maxWidth="50%" focusable ref={rememberPanel(sessionID)}>
            <text wrapMode="none">
              you said {asPercent(owed.saidConfidence ?? 0)}
              {quoted === '' ? '' : ` · "${quoted}"`}
            </text>
            <text wrapMode="none">1: landed</text>
            <text wrapMode="none">2: needed fixing</text>
            <text wrapMode="none">0: Skip</text>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule = { id: 'bet-on-your-agent', tui }

export default plugin
