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

// The engine's own store filename rule (xe in the plugin store):
// an id of only [a-z0-9._-] is `<id>.json`; anything else, including the
// `@` in `name@source`, is the sanitized id, a dash, and the first 12 hex
// digits of sha256(id). `$.store` exposes get, set, delete, and keys, and
// no path, so the filename is derived here the same way.
const PLAIN_ID = /^[a-z0-9._-]+$/
const DEVICE_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const ID_LIMIT = 64
const HASH_LEN = 12

export function storeFileName(id: string): string {
  if (PLAIN_ID.test(id) && !DEVICE_ID.test(id) && id.length <= ID_LIMIT && id !== '.' && id !== '..') {
    return `${id}.json`
  }
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, ID_LIMIT) || 'plugin'

  return `${cleaned}-${sha256(id).slice(0, HASH_LEN)}.json`
}

const fileName = (row: unknown): string | undefined => {
  if (typeof row === 'string') return row
  if (typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string') return row.name

  return undefined
}

const pluginDirName = (): string => {
  const path = decodeURIComponent(import.meta.url.replace(/^file:\/\//, ''))
  const parts = path.split(/[/\\]/).filter(part => part !== '')
  const hooks = parts.lastIndexOf('hooks')

  return hooks > 0 ? (parts[hooks - 1] ?? PLUGIN) : PLUGIN
}

/** A marketplace install lives at `plugins/cache/<marketplace>/<plugin>/<version>`. */
const marketplaceOf = (plugin: string): string | undefined => {
  const path = decodeURIComponent(import.meta.url.replace(/^file:\/\//, ''))
  const parts = path.split(/[/\\]/).filter(part => part !== '')
  for (let at = 0; at < parts.length - 3; at += 1) {
    const root = parts[at]
    if ((root === 'plugins' || root === 'cowork_plugins') && parts[at + 1] === 'cache' && parts[at + 3] === plugin) {
      return parts[at + 2]
    }
  }

  return undefined
}

/**
 * The store file for the plugin that is running.
 *
 * `claude plugin test` loads the folder as `<folder>@claude-plugin-test`.
 * `--plugin-dir` loads it as `<name>@inline`. A marketplace install loads it
 * as `<name>@<marketplace>`. Other sources' files in the same directory are
 * left alone.
 */
async function currentStoreFile($: EngineInterface): Promise<string | undefined> {
  const dir = await storeDir($)
  if (dir === undefined) return undefined
  const listed = await $.fs.list(dir).catch(() => undefined)
  if (!Array.isArray(listed)) return undefined
  const names = new Set<string>()
  for (const row of listed) {
    const name = fileName(row)
    if (name !== undefined) names.add(name)
  }
  const plugin = pluginDirName()
  const harness = storeFileName(`${plugin}@claude-plugin-test`)
  const market = marketplaceOf(plugin)
  let id = `${plugin}@inline`
  if (market !== undefined) id = `${plugin}@${market}`
  else if (names.has(harness)) id = `${plugin}@claude-plugin-test`
  const name = storeFileName(id)
  if (!names.has(name)) return undefined

  return `${dir}/${name}`
}

/**
 * A missing file is left alone. Zero bytes holds nothing, so it becomes an
 * empty store. Anything that is not usable JSON, or a store whose turns are
 * not a list, is copied to `.bak` and then rebuilt.
 */
export async function repairPluginStore($: EngineInterface): Promise<StoreRepair> {
  const path = await currentStoreFile($)
  if (path === undefined) return 'none'

  return repairFile($, path)
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

function sha256(text: string): string {
  const bits = new Uint8Array(text.length)
  for (let at = 0; at < text.length; at += 1) bits[at] = text.charCodeAt(at) & 0xff
  const bitLength = bits.length * 8
  const data = new Uint8Array(Math.ceil((bits.length + 9) / 64) * 64)
  data.set(bits)
  data[bits.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(data.length - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(data.length - 4, bitLength >>> 0, false)

  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ])
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let block = 0; block < data.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = hash[0]!
    let b = hash[1]!
    let c = hash[2]!
    let d = hash[3]!
    let e = hash[4]!
    let f = hash[5]!
    let g = hash[6]!
    let h = hash[7]!
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + s1 + ch + k[i]! + w[i]!) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (s0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }
  let hex = ''
  for (const word of hash) hex += word.toString(16).padStart(8, '0')

  return hex
}

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))
