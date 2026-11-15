import type { TurnRecord } from '../../bet-on-your-agent/types/index.ts'
import { TURNS_KV_KEY } from './track.ts'

/**
 * The slice of `api.kv` this plugin uses.
 *
 * `ready` stays false until the host has read the shared `kv.json` into
 * memory. A `set` before that snapshots the still-empty memory and the
 * host's queued write replaces the whole file with that snapshot.
 */
export type TurnKv = {
  readonly ready: boolean
  get: <Value>(key: string, fallback?: Value) => Value
  set: (key: string, value: unknown) => void
}

type Edit = (records: readonly TurnRecord[]) => TurnRecord[]
type AfterWrite = (prev: readonly TurnRecord[], next: TurnRecord[]) => void

type Pending = { edit: Edit; after?: AfterWrite }

/**
 * History for `TURNS_KV_KEY`.
 *
 * Reads and writes wait until `kv.ready`. A turn that ends first is held as
 * an edit and applied onto the hydrated list, so the write never replaces
 * another plugin's keys or this plugin's earlier turns.
 */
export const createTurnLog = (kv: TurnKv, onChange?: (records: readonly TurnRecord[]) => void) => {
  const pending: Pending[] = []

  const disk = (): TurnRecord[] => kv.get<TurnRecord[]>(TURNS_KV_KEY, [])

  const preview = (): TurnRecord[] => pending.reduce((records, item) => item.edit(records), [] as TurnRecord[])

  const publish = (records: readonly TurnRecord[]) => {
    onChange?.(records)
  }

  return {
    load(): TurnRecord[] {
      if (!kv.ready) return preview()

      return disk()
    },
    update(edit: Edit, after?: AfterWrite) {
      if (!kv.ready) {
        pending.push({ edit, ...(after === undefined ? {} : { after }) })
        publish(preview())

        return
      }
      const prev = disk()
      const next = edit(prev)
      kv.set(TURNS_KV_KEY, next)
      publish(next)
      after?.(prev, next)
    },
    /** Apply held edits once `kv.ready`. Returns false while the store is still hydrating. */
    flush(): boolean {
      if (!kv.ready) return false
      if (pending.length === 0) {
        publish(disk())

        return true
      }
      let records = disk()
      const queued = pending.splice(0, pending.length)
      for (const item of queued) {
        const prev = records
        records = item.edit(records)
        item.after?.(prev, records)
      }
      kv.set(TURNS_KV_KEY, records)
      publish(records)

      return true
    },
  }
}
