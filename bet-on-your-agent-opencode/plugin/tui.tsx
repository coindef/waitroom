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
 * - **Counting files an `apply_patch` call touched.** See `track.ts`.
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
  rankImproved,
  report,
  setVerdict,
  shortAsk,
  skipVerdict,
} from '../../bet-on-your-agent/hooks/bet.ts'
import type { BonusBucket, BonusDim, FileBucket, RankChange, TurnRecord } from '../../bet-on-your-agent/types/index.ts'
import { askFrom, filePathOf, isBusy, isNewCompletion, TURNS_KV_KEY } from './track.ts'

type OpenBet = {
  turnId: string
  ask: string
  files: string[]
  startedAt: number
  toolCalls: number
  saidConfidence?: number
  saidFiles?: FileBucket
  isDeclined?: true
  bonusDim?: BonusDim
  saidBonus?: BonusBucket
  isBonusDeclined?: true
}

const noBet = (): OpenBet => ({ turnId: '', ask: '', files: [], startedAt: 0, toolCalls: 0 })

/** A verdict just given, kept per session so the slot can name a rank climb once, the same moment the Claude Code mod's band does. */
type LastVerdict = { result: 'landed' | 'fixed' | 'skipped'; rankUp?: RankChange }

export const tui: TuiPlugin = async api => {
  const open = new Map<string, OpenBet>()
  const tracking = new Set<string>()
  const lastVerdict = new Map<string, LastVerdict>()
  const toolCallsCounted = new Map<string, Set<string>>()
  // How many sessions have offered a bonus question so far; drives the
  // rotation the same way the Claude Code mod's `bonusRotation` atom does.
  let bonusRotation = 0

  const openFor = (sessionID: string): OpenBet => open.get(sessionID) ?? noBet()

  const loadTurns = (): TurnRecord[] => api.kv.get<TurnRecord[]>(TURNS_KV_KEY, [])
  const saveTurns = (records: readonly TurnRecord[]) => api.kv.set(TURNS_KV_KEY, records)

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
      if (isBusy(status)) {
        if (tracking.has(sessionID)) return
        tracking.add(sessionID)
        const dim = bonusDimFor(bonusRotation)
        bonusRotation++
        open.set(sessionID, {
          ...noBet(),
          turnId: crypto.randomUUID(),
          ask: await askForTurn(sessionID),
          startedAt: Date.now(),
          bonusDim: dim,
        })
        // A new turn's own questions take over the slot; the last verdict is
        // settled by now, or it would still be the one being asked about.
        lastVerdict.delete(sessionID)

        return
      }
      if (!tracking.has(sessionID)) return
      tracking.delete(sessionID)

      const bet = openFor(sessionID)
      const files = bet.files.length
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
      saveTurns(keepRecord(loadTurns(), record))
      open.delete(sessionID)
      toolCallsCounted.delete(sessionID)
    }),
  )

  api.lifecycle.onDispose(
    api.event.on('message.part.updated', ({ properties }) => {
      const part = properties.part
      if (part.type !== 'tool') return
      const sessionID = part.sessionID
      if (!tracking.has(sessionID)) return

      const bet = openFor(sessionID)
      const counted = toolCallsCounted.get(sessionID) ?? new Set<string>()
      // Every tool call toward the bonus question, not only the ones that
      // touch a file — the OpenCode equivalent of the Claude Code mod's
      // unfiltered `tool.call` hook.
      const isNewToolCall = isNewCompletion(part, counted)
      if (isNewToolCall) {
        counted.add(part.id)
        toolCallsCounted.set(sessionID, counted)
      }
      const path = filePathOf(part)
      const addsFile = path !== undefined && !bet.files.includes(path)
      if (isNewToolCall || addsFile) {
        open.set(sessionID, {
          ...bet,
          toolCalls: isNewToolCall ? bet.toolCalls + 1 : bet.toolCalls,
          files: addsFile ? [...bet.files, path as string].slice(-200) : bet.files,
        })
      }
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
    open.set(sessionID, { ...openFor(sessionID), saidConfidence: said })
  }

  const placeFiles = (sessionID: string, said: FileBucket) => {
    open.set(sessionID, { ...openFor(sessionID), saidFiles: said })
  }

  const decline = (sessionID: string) => {
    open.set(sessionID, { ...openFor(sessionID), isDeclined: true })
  }

  const placeBonus = (sessionID: string, said: BonusBucket) => {
    open.set(sessionID, { ...openFor(sessionID), saidBonus: said })
  }

  const declineBonus = (sessionID: string) => {
    open.set(sessionID, { ...openFor(sessionID), isBonusDeclined: true })
  }

  const giveVerdict = (sessionID: string, turnId: string, landed: boolean) => {
    const before = loadTurns()
    const fromRank = currentRank(before)
    const after = setVerdict(before, turnId, landed)
    saveTurns(after)
    const toRank = currentRank(after)
    lastVerdict.set(sessionID, {
      result: landed ? 'landed' : 'fixed',
      ...(rankImproved(fromRank, toRank) ? { rankUp: { from: fromRank, to: toRank } } : {}),
    })
  }
  const waveVerdict = (sessionID: string, turnId: string) => {
    saveTurns(skipVerdict(loadTurns(), turnId))
    lastVerdict.set(sessionID, { result: 'skipped' })
  }

  const bandCommand = (name: string, run: (sessionID: string) => void) => ({
    name,
    run: () => {
      const sessionID = activeSessionId()
      if (!sessionID) return false
      run(sessionID)
    },
  })

  const dispose = api.keymap.registerLayer({
    bindings: [
      { key: '1', cmd: 'bet.digit-1' },
      { key: '2', cmd: 'bet.digit-2' },
      { key: '3', cmd: 'bet.digit-3' },
      { key: '4', cmd: 'bet.digit-4' },
      { key: '5', cmd: 'bet.digit-5' },
      { key: '0', cmd: 'bet.digit-0' },
    ],
    // One command per digit, each branching on the open bet's current phase —
    // the same digit means confidence, then files, then (after the turn
    // lands) a verdict, never more than one question at a time. This mirrors
    // the Claude Code mod's own `ui.render` branching; see its
    // `hooks/register.tsx`.
    commands: [1, 2, 3, 4, 5, 0].map(digit =>
      bandCommand(`bet.digit-${digit}`, sessionID => {
        const bet = openFor(sessionID)
        if (bet.turnId !== '' && bet.isDeclined !== true) {
          // `0` declines whichever phase is open; the confidence and files
          // phases have no skip of their own, unlike the bonus phase below —
          // mirrors the Claude Code mod's own band, where the files phase's
          // skip button is also wired to `declineBet`, not a files-only skip.
          if (bet.saidConfidence === undefined) {
            if (digit === 0) return decline(sessionID)
            const band = BANDS[digit - 1]
            if (band !== undefined) placeConfidence(sessionID, band)

            return
          }
          if (bet.saidFiles === undefined) {
            if (digit === 0) return decline(sessionID)
            const bucket = FILE_BUCKETS[digit - 1]
            if (bucket !== undefined) placeFiles(sessionID, bucket)

            return
          }
          if (bet.bonusDim !== undefined && bet.saidBonus === undefined && bet.isBonusDeclined !== true) {
            if (digit === 0) return declineBonus(sessionID)
            const bucket = BONUS_BUCKETS[bet.bonusDim][digit - 1]
            if (bucket !== undefined) placeBonus(sessionID, bucket)
          }

          return
        }

        const owed = owedVerdict(loadTurns())
        if (!owed) return
        if (digit === 1) giveVerdict(sessionID, owed.turnId, true)
        else if (digit === 2) giveVerdict(sessionID, owed.turnId, false)
        else if (digit === 3) waveVerdict(sessionID, owed.turnId)
      }),
    ),
  })
  api.lifecycle.onDispose(dispose)

  // Legacy, typed `@deprecated` surface — see this file's header comment.
  // Kept anyway because it is the only typed way this package version offers
  // to answer to `/bet`; a non-deprecated replacement was not found.
  api.command?.register(() => [
    {
      title: 'Bet on your agent: your record',
      value: 'bet.report',
      slash: { name: 'bet' },
      onSelect: dialog => {
        const text = asText(report(loadTurns()))
        dialog?.replace(() => <box flexDirection="column">{text.split('\n').map(line => <text>{line}</text>)}</box>)
      },
    },
  ])

  api.slots.register({
    slots: {
      session_prompt_right: (_ctx, props: { session_id: string }) => {
        const sessionID = props.session_id
        const bet = openFor(sessionID)
        const room = askRoomFor(80)

        if (bet.turnId !== '' && bet.isDeclined !== true) {
          const quoted = shortAsk(bet.ask, room)
          const about = quoted === '' ? '' : ` "${quoted}"`

          if (bet.saidConfidence === undefined) {
            return (
              <box flexDirection="row" gap={1} maxWidth="50%">
                <text wrapMode="none">
                  Will{about} land first try?
                </text>
                {BANDS.map((band, at) => (
                  <text wrapMode="none">
                    {at + 1}: {asPercent(band)}
                  </text>
                ))}
                <text wrapMode="none">0: skip</text>
              </box>
            )
          }

          if (bet.saidFiles === undefined) {
            return (
              <box flexDirection="row" gap={1} maxWidth="50%">
                <text wrapMode="none">
                  {asPercent(bet.saidConfidence)} · how many files?
                </text>
                {FILE_BUCKETS.map((bucket, at) => (
                  <text wrapMode="none">
                    {at + 1}: {bucket}
                  </text>
                ))}
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
              <box flexDirection="row" gap={1} maxWidth="50%">
                <text wrapMode="none">
                  Bonus: {BONUS_QUESTIONS[dim]}
                </text>
                {buckets.map((bucket, at) => (
                  <text wrapMode="none">
                    {at + 1}: {bonusLabel(dim, bucket)}
                  </text>
                ))}
                <text wrapMode="none">0: skip</text>
              </box>
            )
          }

          return (
            <text wrapMode="none" maxWidth="50%">
              bet {asPercent(bet.saidConfidence)} · {filesPhrase(bet.saidFiles)} · {bet.files.length} written so far
            </text>
          )
        }

        const owed = owedVerdict(loadTurns())
        if (!owed) {
          const last = lastVerdict.get(sessionID)
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
          <box flexDirection="row" gap={1} maxWidth="50%">
            <text wrapMode="none">
              {quoted === '' ? 'That turn' : `"${quoted}"`} — you said {asPercent(owed.saidConfidence ?? 0)}.
            </text>
            <text wrapMode="none">1: landed</text>
            <text wrapMode="none">2: needed fixing</text>
            <text wrapMode="none">3: skip</text>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule = { id: 'bet-on-your-agent', tui }

export default plugin
