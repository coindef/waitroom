import type { EngineInterface } from 'claude-code'

const FILE = 'bet-on-your-agent.json'

// One line, lowercase, and short enough for a 48-column terminal.
export const REBUILT_NOTICE = "couldn't read the saved history · rebuilt"

export type StoreRepair = 'none' | 'empty' | 'rebuilt'

/**
 * The plugin store file: `{config}/plugins/store/bet-on-your-agent.json`.
 *
 * `config` is `CLAUDE_CONFIG_DIR`, or `~/.claude` when that is unset. A test
 * points the variable at its own directory, so this never has to be the real
 * `~/.claude/plugins/store` files.
 */
export async function storeFilePath($: EngineInterface): Promise<string | undefined> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = await $.env.get('HOME').catch(() => undefined)
  const root =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured.trim()
      : typeof home === 'string' && home.trim() !== ''
        ? `${home.trim().replace(/[\\/]+$/, '')}/.claude`
        : undefined
  if (root === undefined) return undefined

  return `${root.replace(/[\\/]+$/, '')}/plugins/store/${FILE}`
}

/**
 * A missing file is left alone. Zero bytes holds nothing, so it becomes an
 * empty store. Anything that is not usable JSON, or a store whose turns are
 * not a list, is copied to `.bak` and then rebuilt.
 */
export async function repairPluginStore($: EngineInterface): Promise<StoreRepair> {
  const path = await storeFilePath($)
  if (path === undefined) return 'none'
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
