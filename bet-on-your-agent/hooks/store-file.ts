import type { EngineInterface } from 'claude-code'

const PLUGIN = 'bet-on-your-agent'

// One line, lowercase, and short enough for a 48-column terminal.
export const REBUILT_NOTICE = "couldn't read the saved history · rebuilt"

export type StoreRepair = 'none' | 'empty' | 'rebuilt'

/**
 * The directory the engine keeps plugin stores in.
 *
 * `config` is `CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset. A test
 * points the variable at its own directory, so this never has to be the real
 * `~/.claude/plugins/store` files.
 */
export async function storeDir($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = await $.env.get('HOME').catch(() => undefined)
  const root =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured.trim()
      : typeof home === 'string' && home.trim() !== ''
        ? `${home.trim().replace(/[\\/]+$/, '')}/.claude`
        : undefined
  if (root === undefined) return undefined

  return `${root.replace(/[\\/]+$/, '')}/plugins/store`
}

/**
 * A store file for this plugin.
 *
 * The engine names it from the plugin and its source, `name@source`, which
 * is not a plain filename: `@` becomes `_` and a short hash is added. An
 * inline session is `bet-on-your-agent_inline-b4b76a335767.json`. The
 * marketplace session is `bet-on-your-agent_waitroom-34ea4b598520.json`.
 * `bet-on-your-agent.json` is not a name the engine writes.
 */
const isStoreFile = (name: string): boolean =>
  name.endsWith('.json') && (name === `${PLUGIN}.json` || name.startsWith(`${PLUGIN}_`))

const fileName = (row: unknown): string | undefined => {
  if (typeof row === 'string') return row
  if (typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string') return row.name

  return undefined
}

/**
 * A missing file is left alone. Zero bytes holds nothing, so it becomes an
 * empty store. Anything that is not usable JSON, or a store whose turns are
 * not a list, is copied to `.bak` and then rebuilt.
 *
 * Every store file for this plugin in the directory is considered. A session
 * uses one of them, and the name depends on how the plugin was loaded.
 */
export async function repairPluginStore($: EngineInterface): Promise<StoreRepair> {
  const dir = await storeDir($)
  if (dir === undefined) return 'none'
  const listed = await $.fs.list(dir).catch(() => undefined)
  if (!Array.isArray(listed)) return 'none'
  let result: StoreRepair = 'none'
  for (const row of listed) {
    const name = fileName(row)
    if (name === undefined || !isStoreFile(name)) continue
    const one = await repairFile($, `${dir}/${name}`)
    if (one === 'rebuilt') result = 'rebuilt'
    else if (one === 'empty' && result === 'none') result = 'empty'
  }

  return result
}

async function repairFile($: EngineInterface, path: string): Promise<StoreRepair> {
  const exists = await $.fs.exists(path).then(
    (value: boolean) => value === true,
    () => false,
  )
  if (!exists) return 'none'
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return 'none'
  if (text.length === 0) {
    const wrote = await $.fs.write(path, '{}\n').then(
      () => true,
      () => false,
    )

    return wrote ? 'empty' : 'none'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return rebuild($, path, text, '{}\n')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return rebuild($, path, text, '{}\n')
  const record = parsed as Record<string, unknown>
  if (record.turns === undefined || Array.isArray(record.turns)) return 'none'
  const next = { ...record }
  delete next.turns

  return rebuild($, path, text, `${JSON.stringify(next)}\n`)
}

async function rebuild($: EngineInterface, path: string, raw: string, fresh: string): Promise<StoreRepair> {
  const backedUp = await $.fs.write(`${path}.bak`, raw).then(
    () => true,
    () => false,
  )
  if (!backedUp) return 'none'
  const wrote = await $.fs.write(path, fresh).then(
    () => true,
    () => false,
  )

  return wrote ? 'rebuilt' : 'none'
}
