import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileBucket, OpenBet, TurnRecord } from '../types'
import {
  asDuration,
  asPercent,
  asText,
  BANDS,
  bucketOf,
  COIN_FLIP_BRIER,
  FILE_BUCKETS,
  keepRecord,
  owedVerdict,
  report,
  setVerdict,
} from './bet'

const PANE = 'bet-on-your-agent'
const STORE_KEY = 'turns'
/** Hotkeys for the file-count buttons; the confidence row takes 1 to 5. */
const FILE_KEYS = ['a', 'b', 'c', 'd'] as const

const NO_BET: OpenBet = { turnId: '', files: [] }

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
 * A `$.store` read does not subscribe a drawing, so without the bump the pane
 * would keep showing the history as it stood when it was last drawn.
 */
const saveTurns = async ($: EngineInterface, records: readonly TurnRecord[]) => {
  await $.store.set(STORE_KEY, records)
  await update($, revision, at => at + 1)
}

const showStatus = async ($: EngineInterface) => {
  const isBusy = await read($, busy)
  const bet = await read($, open)
  if (isBusy) {
    const said = bet.saidConfidence === undefined ? 'no bet' : asPercent(bet.saidConfidence)
    $.ui.status(`bet: ${said}`)

    return
  }
  const found = report(await loadTurns($))
  if (found.owed > 0) {
    $.ui.status(`bet: ${found.owed} verdict${found.owed === 1 ? '' : 's'} owed`)

    return
  }
  $.ui.status(found.brier === undefined ? undefined : `bet: Brier ${found.brier.toFixed(2)}`)
}

const placeConfidence = async ($: EngineInterface, said: number) => {
  await update($, open, bet => ({ ...bet, saidConfidence: said }))
  await showStatus($)
}

const placeFiles = async ($: EngineInterface, said: FileBucket) => {
  await update($, open, bet => ({ ...bet, saidFiles: said }))
  await showStatus($)
}

const giveVerdict = async ($: EngineInterface, turnId: string, landed: boolean) => {
  await saveTurns($, setVerdict(await loadTurns($), turnId, landed))
  await showStatus($)
}

const noteFile = async ($: EngineInterface, path: string | undefined) => {
  if (path === undefined || path === '') return
  await update($, open, bet =>
    bet.files.includes(path) ? bet : { ...bet, files: [...bet.files, path].slice(-200) },
  )
}

export const register: Register = (on, options) => {
  const config: Config = { autoOpen: options.autoOpen !== false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bet',
      description: 'How well you call your agent: Brier score and calibration',
    })
    if (config.autoOpen) void $.ui.open({ id: PANE, title: 'Bet on your agent' })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'bet' }, async $ => {
    void $.ui.open({ id: PANE, title: 'Bet on your agent' })

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
    await update($, open, () => ({ turnId: e.turnId, files: [] }))
    await update($, busy, () => true)
    await showStatus($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const bet = await read($, open)
    const files = bet.turnId === e.turnId ? bet.files.length : 0
    const record: TurnRecord = {
      turnId: e.turnId,
      at: await $.clock.now(),
      durationMs: e.durationMs,
      files,
      filesBucket: bucketOf(files),
      isAborted: e.isAborted,
      ...(bet.turnId === e.turnId && bet.saidConfidence !== undefined
        ? { saidConfidence: bet.saidConfidence }
        : {}),
      ...(bet.turnId === e.turnId && bet.saidFiles !== undefined
        ? { saidFiles: bet.saidFiles }
        : {}),
    }
    await saveTurns($, keepRecord(await loadTurns($), record))
    await update($, busy, () => false)
    await showStatus($)

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isBusy = await read($, busy)
    const bet = await read($, open)
    // Read so a saved record redraws this pane; the value itself is not shown.
    await read($, revision)
    const records = await loadTurns($)
    const owed = owedVerdict(records)

    const verdictRow = owed && (
      <Box flexDirection="column">
        <Text>
          You said {asPercent(owed.saidConfidence ?? 0)} on a turn that wrote {owed.files}{' '}
          file{owed.files === 1 ? '' : 's'} in {asDuration(owed.durationMs)}. Did it land?
        </Text>
        <Box gap={2}>
          <Button key="landed" hotkey="y" plain onPress={() => giveVerdict($, owed.turnId, true)}>
            landed
          </Button>
          <Button key="fixed" hotkey="n" plain onPress={() => giveVerdict($, owed.turnId, false)}>
            needed fixing
          </Button>
        </Box>
      </Box>
    )

    if (isBusy) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            Turn running · {bet.files.length} file{bet.files.length === 1 ? '' : 's'} written so far
          </Text>

          <Box flexDirection="column">
            <Text>Will it land first try?</Text>
            {bet.saidConfidence === undefined ? (
              <Box gap={2}>
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
              </Box>
            ) : (
              <Text dimColor>you said {asPercent(bet.saidConfidence)}</Text>
            )}
          </Box>

          <Box flexDirection="column">
            <Text>How many files will it touch?</Text>
            {bet.saidFiles === undefined ? (
              <Box gap={2}>
                {FILE_BUCKETS.map((bucket, at) => (
                  <Button
                    key={`f${bucket}`}
                    hotkey={FILE_KEYS[at]}
                    plain
                    onPress={() => placeFiles($, bucket)}
                  >
                    {bucket}
                  </Button>
                ))}
              </Box>
            ) : (
              <Text dimColor>you said {bet.saidFiles}</Text>
            )}
          </Box>

          {verdictRow}
        </Box>
      )
    }

    if (owed) return <Box flexDirection="column">{verdictRow}</Box>

    const found = report(records)
    if (found.brier === undefined) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            {found.recorded === 0
              ? 'No turns yet. Call the next one while it runs.'
              : `${found.recorded} turns recorded, none scored yet.`}
          </Text>
          <Text dimColor>Bet on a turn while it runs, then say whether it landed.</Text>
        </Box>
      )
    }

    const room = Math.max(2, (e.viewport?.rows ?? 24) - 8)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Brier {found.brier.toFixed(3)} over {found.scored} turns
          </Text>
          <Text dimColor>
            {found.brier < COIN_FLIP_BRIER ? 'better than a coin flip' : 'no better than a coin flip'}
            {found.lean === 'fair'
              ? ' · your average forecast matches what happens'
              : ` · ${Math.abs(found.gap ?? 0)} points ${found.lean}confident`}
          </Text>
        </Box>

        <Box flexDirection="column">
          {found.rows.slice(0, room).map(row => (
            <Text key={`row${Math.round(row.said * 100)}`} dimColor={row.lean === 'fair'}>
              said {asPercent(row.said).padStart(4)} · actual {asPercent(row.actual).padStart(4)} ·{' '}
              {row.turns} turn{row.turns === 1 ? '' : 's'}
              {row.lean === 'fair' ? '' : ` · ${row.lean}confident`}
            </Text>
          ))}
        </Box>

        <Text dimColor>
          {found.files ? `files called ${found.files.right}/${found.files.of} · ` : ''}
          {found.landed ? `lands first try ${asPercent(found.landed.yes / found.landed.of)} · ` : ''}
          {found.medianMs === undefined ? '' : `median ${asDuration(found.medianMs)}`}
        </Text>
      </Box>
    )
  })
}
