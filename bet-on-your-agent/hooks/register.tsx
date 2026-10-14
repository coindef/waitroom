import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileBucket, OpenBet, TurnRecord } from '../types'
import {
  asDuration,
  askRoomFor,
  asPercent,
  asText,
  BANDS,
  CALIBRATION_HEAD,
  calibrationLine,
  bucketOf,
  COIN_FLIP_BRIER,
  FILE_BUCKETS,
  headline,
  keepRecord,
  owedVerdict,
  report,
  setVerdict,
  shortAsk,
  skipVerdict,
} from './bet'

const PANE = 'bet-on-your-agent'
const STORE_KEY = 'turns'

const NO_BET: OpenBet = { turnId: '', ask: '', files: [] }

const open = atom({ plugin: 'bet-on-your-agent', key: 'open' } as const, NO_BET)
const busy = atom({ plugin: 'bet-on-your-agent', key: 'busy' } as const, false)
const revision = atom({ plugin: 'bet-on-your-agent', key: 'revision' } as const, 0)

type Config = { autoOpen: boolean }

/** The stored history, or nothing when the store holds something else. */
const loadTurns = async ($: EngineInterface): Promise<TurnRecord[]> => {
  const raw = await $.store.get(STORE_KEY).catch(() => undefined)

  return Array.isArray(raw) ? (raw as TurnRecord[]) : []
}

/**
 * Writes the history and bumps `revision`.
 *
 * A `$.store` read does not subscribe a drawing, so without the bump the band
 * and pane would keep showing the history as it stood when last drawn.
 */
const saveTurns = async ($: EngineInterface, records: readonly TurnRecord[]) => {
  await $.store.set(STORE_KEY, records)
  await update($, revision, at => at + 1)
}

/**
 * The status line, which is a convenience: it never throws outward, because a
 * failure here would otherwise abort whatever hook was keeping it up to date —
 * including the one that records the turn.
 */
const showStatus = async ($: EngineInterface) => {
  try {
    const isBusy = await read($, busy)
    const bet = await read($, open)
    if (isBusy) {
      const said = bet.saidConfidence === undefined ? 'open' : asPercent(bet.saidConfidence)
      $.ui.status(`bet: ${said}`)

      return
    }
    const found = report(await loadTurns($))
    if (found.owed > 0) {
      $.ui.status(`bet: ${found.owed} verdict${found.owed === 1 ? '' : 's'} owed`)

      return
    }
    $.ui.status(found.brier === undefined ? undefined : `bet: Brier ${found.brier.toFixed(2)}`)
  } catch {
    // Nothing to do: the record is still kept, only unshown.
  }
}

const placeConfidence = async ($: EngineInterface, said: number) => {
  await update($, open, bet => ({ ...bet, saidConfidence: said }))
  await showStatus($)
}

const placeFiles = async ($: EngineInterface, said: FileBucket) => {
  await update($, open, bet => ({ ...bet, saidFiles: said }))
  await showStatus($)
}

/** Waves this turn's bet away, so the band stops asking for the rest of it. */
const declineBet = async ($: EngineInterface) => {
  await update($, open, bet => ({ ...bet, isDeclined: true as const }))
  await showStatus($)
}

const giveVerdict = async ($: EngineInterface, turnId: string, landed: boolean) => {
  await saveTurns($, setVerdict(await loadTurns($), turnId, landed))
  await showStatus($)
}

const waveVerdict = async ($: EngineInterface, turnId: string) => {
  await saveTurns($, skipVerdict(await loadTurns($), turnId))
  await showStatus($)
}

const noteFile = async ($: EngineInterface, path: string | undefined) => {
  if (path === undefined || path === '') return
  await update($, open, bet =>
    bet.files.includes(path) ? bet : { ...bet, files: [...bet.files, path].slice(-200) },
  )
}

export const register: Register = (on, options) => {
  const config: Config = { autoOpen: options.autoOpen === true }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bet',
      description: 'How well you call your agent: Brier score and calibration',
    })
    if (config.autoOpen) void $.ui.open({ id: PANE, title: 'Bet on your agent' }).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bet' }, async $ => {
    void $.ui.open({ id: PANE, title: 'Bet on your agent' }).catch(() => undefined)

    return { text: asText(report(await loadTurns($))) }
  })

  // One hook per tool so `e` narrows to that tool's own input.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteFile($, e.file_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteFile($, e.file_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.deny && !ran.isError) await noteFile($, e.notebook_path)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // The betting window opens here and closes when the turn lands.
    await update($, open, () => ({ turnId: e.turnId, ask: e.text, files: [] }))
    await update($, busy, () => true)
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const bet = await read($, open)
    const isThisTurn = bet.turnId === e.turnId
    const files = isThisTurn ? bet.files.length : 0
    const ask = isThisTurn ? shortAsk(bet.ask) : ''
    const record: TurnRecord = {
      turnId: e.turnId,
      at: await $.clock.now(),
      durationMs: e.durationMs,
      files,
      filesBucket: bucketOf(files),
      isAborted: e.isAborted,
      ...(ask === '' ? {} : { ask }),
      ...(isThisTurn && bet.saidConfidence !== undefined
        ? { saidConfidence: bet.saidConfidence }
        : {}),
      ...(isThisTurn && bet.saidFiles !== undefined ? { saidFiles: bet.saidFiles } : {}),
    }
    await saveTurns($, keepRecord(await loadTurns($), record))
    await update($, busy, () => false)
    await showStatus($)

    return done
  }).catch(($, e, next) => next(e))

  /**
   * The band is where betting lives.
   *
   * It sits where the person is already looking while they wait, it costs no
   * pane, and a bare digit typed into an empty composer answers its buttons —
   * so a forecast is one keystroke with no focus to manage. Only ever one
   * question at a time, so the digits always mean the obvious thing.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey of the engine's own owns the band while it is up.
    if (e.props.hasSurvey) return next(e)

    const bet = await read($, open)
    await read($, revision)
    const { Box, Text, Button } = $.ui.resolve(e)
    const room = askRoomFor(e.props.bodyColumns)

    if (e.props.isWorking && bet.turnId !== '' && bet.isDeclined !== true) {
      const said = bet.saidConfidence
      const quoted = shortAsk(bet.ask, room)
      const about = quoted === '' ? '' : ` "${quoted}"`

      if (said === undefined) {
        return (
          <Box gap={1}>
            <Text>Will{about} land first try?</Text>
            {BANDS.map((band, at) => (
              <Button
                key={`p${Math.round(band * 100)}`}
                hotkey={String(at + 1)}
                plain
                onPress={() => placeConfidence($, band)}
              >
                {asPercent(band)}
              </Button>
            ))}
            <Button key="decline" hotkey="0" plain dimColor onPress={() => declineBet($)}>
              skip
            </Button>
          </Box>
        )
      }

      if (bet.saidFiles === undefined) {
        return (
          <Box gap={1}>
            <Text dimColor>{asPercent(said)} ·</Text>
            <Text>how many files?</Text>
            {FILE_BUCKETS.map((bucket, at) => (
              <Button
                key={`f${bucket}`}
                hotkey={String(at + 1)}
                plain
                onPress={() => placeFiles($, bucket)}
              >
                {bucket}
              </Button>
            ))}
            <Button key="decline" hotkey="0" plain dimColor onPress={() => declineBet($)}>
              skip
            </Button>
          </Box>
        )
      }

      return (
        <Box>
          <Text dimColor>
            bet {asPercent(said)} · {bet.saidFiles} files · {bet.files.length} written so far
          </Text>
        </Box>
      )
    }

    const owed = owedVerdict(await loadTurns($))
    if (!owed) return next(e)

    const quoted = owed.ask === undefined ? '' : shortAsk(owed.ask, room)

    return (
      <Box gap={1}>
        <Text>
          {quoted === '' ? 'That turn' : `"${quoted}"`} — you said{' '}
          {asPercent(owed.saidConfidence ?? 0)}.
        </Text>
        <Button key="landed" hotkey="1" plain onPress={() => giveVerdict($, owed.turnId, true)}>
          landed
        </Button>
        <Button key="fixed" hotkey="2" plain onPress={() => giveVerdict($, owed.turnId, false)}>
          needed fixing
        </Button>
        <Button key="skip" hotkey="3" plain dimColor onPress={() => waveVerdict($, owed.turnId)}>
          skip
        </Button>
      </Box>
    )
  })

  // The pane is the record: what the band collects, read back. /bet opens it.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, revision)
    const found = report(await loadTurns($))

    if (found.brier === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            {found.recorded === 0
              ? 'No turns yet. Call the next one from the row above the prompt.'
              : `${found.recorded} turns recorded, none scored yet.`}
          </Text>
          <Text dimColor>Bet while a turn runs, then say whether it landed.</Text>
        </Box>
      )
    }

    const rows = Math.max(2, (e.viewport?.rows ?? 24) - 12)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{headline(found)}</Text>
          <Text dimColor>
            Brier {found.brier.toFixed(3)} over {found.scored} turns ·{' '}
            {found.brier < COIN_FLIP_BRIER ? 'better than a coin flip' : 'no better than a coin flip'}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text dimColor tabular>
            {CALIBRATION_HEAD}
          </Text>
          {found.rows.slice(0, rows).map(row => (
            <Text
              key={`row${Math.round(row.said * 100)}`}
              tabular
              color={row.lean === 'over' ? 'warning' : row.lean === 'under' ? 'subtle' : 'success'}
            >
              {calibrationLine(row)}
            </Text>
          ))}
        </Box>

        {found.misses.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Worst calls</Text>
            {found.misses.map(miss => (
              <Text key={`miss${miss.ask ?? ''}${miss.said}`}>
                {asPercent(miss.said)} {miss.landed ? 'and it landed' : 'and it did not'} —{' '}
                <Text dimColor>{miss.ask ?? 'a turn with no prompt'}</Text>
              </Text>
            ))}
          </Box>
        )}

        <Text dimColor>
          {found.files ? `files called ${found.files.right}/${found.files.of} · ` : ''}
          {found.landed ? `lands first try ${asPercent(found.landed.yes / found.landed.of)} · ` : ''}
          {found.medianMs === undefined ? '' : `median ${asDuration(found.medianMs)}`}
        </Text>
      </Box>
    )
  })
}
