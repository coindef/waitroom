import type { EngineInterface } from 'claude-code'

/** Short bound for the test rendezvous. Never rely on this in production. */
const BARRIER_WAIT_MS = 15_000

/**
 * Test-only store rendezvous for `demo/real-store-race.sh`.
 *
 * Both must be set or the gate is off:
 * - `WAIT_ANCHOR_STORE_BARRIER` — directory for stamp files
 * - `WAIT_ANCHOR_STORE_BARRIER_OK=1` — explicit enable
 *
 * Never set either in production. Unset, persistNote writes straight through.
 *
 * These are function declarations (not const arrows) so the hooks loader can
 * follow `$` across the import from register.ts.
 */
export async function barrierRoot($: EngineInterface): Promise<string | undefined> {
  const ok = await $.env.get('WAIT_ANCHOR_STORE_BARRIER_OK').catch(() => undefined)
  if (typeof ok !== 'string' || ok.trim() !== '1') return undefined
  const raw = await $.env.get('WAIT_ANCHOR_STORE_BARRIER').catch(() => undefined)
  if (typeof raw !== 'string') return undefined
  const dir = raw.trim().replace(/[\\/]+$/, '')

  return dir === '' ? undefined : dir
}

async function sessionFileId($: EngineInterface): Promise<string> {
  const id = await $.session.id().catch(() => undefined)
  if (typeof id !== 'string' || id.trim() === '') throw new Error('wait-anchor: store barrier has no session id')

  return id.trim()
}

async function stampGate(
  $: EngineInterface,
  dir: string,
  kind: 'arrive' | 'release' | 'start' | 'done',
  sid: string,
  op: 'set' | 'delete',
): Promise<void> {
  const now = await $.clock.now()
  await $.fs.write(`${dir}/${kind}-${sid}`, `${op} ${now}\n`)
}

/** Count files whose names start with `prefix` (`arrive-` or `release-`). */
async function countStamps($: EngineInterface, dir: string, prefix: string): Promise<number> {
  const listed = await $.fs.list(dir)
  let count = 0
  if (!Array.isArray(listed)) return 0
  for (const row of listed) {
    const name = typeof row === 'object' && row !== null && 'name' in row ? row.name : undefined
    if (typeof name === 'string' && name.startsWith(prefix)) count += 1
  }

  return count
}

async function waitForStamps($: EngineInterface, dir: string, prefix: string): Promise<void> {
  const deadline = (await $.clock.now()) + BARRIER_WAIT_MS
  while (true) {
    if ((await countStamps($, dir, prefix)) >= 2) return
    if ((await $.clock.now()) >= deadline) {
      throw new Error(`wait-anchor: store barrier timed out waiting for ${prefix}`)
    }
    // 1ms so the wait itself does not inflate the store critical section.
    await $.clock.sleep(1)
  }
}

/**
 * Rendezvous only: both writers arrive and release before either store call.
 * Returns the gate directory, or undefined when the test flags are unset.
 */
export async function enterStoreGate($: EngineInterface, op: 'set' | 'delete'): Promise<string | undefined> {
  const dir = await barrierRoot($)
  if (dir === undefined) return undefined
  const sid = await sessionFileId($)
  await stampGate($, dir, 'arrive', sid, op)
  await waitForStamps($, dir, 'arrive-')
  await stampGate($, dir, 'release', sid, op)
  await waitForStamps($, dir, 'release-')

  return dir
}

/** Stamp immediately before `$.store.set` / `$.store.delete`. */
export async function stampStoreStart(
  $: EngineInterface,
  dir: string | undefined,
  op: 'set' | 'delete',
): Promise<void> {
  if (dir === undefined) return
  await stampGate($, dir, 'start', await sessionFileId($), op)
}

/** Stamp after the store call returns. */
export async function stampStoreDone(
  $: EngineInterface,
  dir: string | undefined,
  op: 'set' | 'delete',
): Promise<void> {
  if (dir === undefined) return
  await stampGate($, dir, 'done', await sessionFileId($), op)
}
