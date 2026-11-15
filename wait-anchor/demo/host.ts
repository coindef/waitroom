/**
 * SIMULATED HOST FIXTURE.
 *
 * This is not Claude Code. It calls the real `register` with the events the
 * mods API documents (`session.start`, `command.run`, `turn.complete`,
 * `prompt.submit`) and a stand-in for `$`. The note logic is the plugin's.
 * A test or the demo labels every run that uses this file.
 */

import { register } from '../hooks/register'

export type HostCalls = { http: number; model: number; messages: number }

export type Installed = {
  status: (string | undefined)[]
  logs: string[]
  /** `set`, `delete`, `log`, `status`, in the order the stand-in saw them. */
  order: string[]
  /** How many hook failures the stand-in forwarded with `next(e)`. The error does not leave `dispatch`. */
  recovered: { count: number }
  /** Values of the readonly `next.error` property. Not a function. */
  failures: { message: string }[]
  /** How many times the hook read `next.error`. */
  errorReads: { count: number }
  /** The next N store sets throw and do not change the map. The next N gets throw and do not read it. */
  fail: { sets: number; gets: number }
  /**
   * Pause the next `$.env.get`. The turn-end save reads that after it has
   * loaded the note and before it writes. `entered` resolves once the read is waiting.
   */
  pauseNextGate: () => { entered: Promise<void>; release: () => void }
  calls: HostCalls
  store: Map<string, unknown>
  prompts: unknown[]
  dispatch: (event: string, payload: Record<string, unknown>) => Promise<unknown>
}

type Hook = ($: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>

const matches = (filter: Record<string, unknown>, payload: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, value]) => payload[key] === value)

/**
 * One process of the fixture. Pass the same `store` to a second `install` to
 * imitate a restart, or a second `install` with another root and session id
 * to imitate a second session on the one plugin store.
 */
export const install = (options: {
  root?: string
  sessionId?: string
  store?: Map<string, unknown>
}): Installed => {
  const store = options.store ?? new Map<string, unknown>()
  const status: (string | undefined)[] = []
  const logs: string[] = []
  const order: string[] = []
  const recovered = { count: 0 }
  const failures: { message: string }[] = []
  const errorReads = { count: 0 }
  const fail = { sets: 0, gets: 0 }
  let gateWait: { entered: () => void; release: Promise<void> } | undefined
  const pauseNextGate = () => {
    let entered!: () => void
    let release!: () => void
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    const releasePromise = new Promise<void>(resolve => {
      release = resolve
    })
    gateWait = { entered, release: releasePromise }

    return { entered: enteredPromise, release }
  }
  const prompts: unknown[] = []
  const calls: HostCalls = { http: 0, model: 0, messages: 0 }
  const hooks: { event: string; filter: Record<string, unknown>; fn: Hook; recover?: Hook }[] = []

  const on = (event: string, filterOrFn: unknown, maybeFn?: unknown) => {
    const hasFilter = maybeFn !== undefined
    const row = {
      event,
      filter: hasFilter ? (filterOrFn as Record<string, unknown>) : {},
      fn: (hasFilter ? maybeFn : filterOrFn) as Hook,
      recover: undefined as Hook | undefined,
    }
    hooks.push(row)

    return {
      catch(recover: Hook) {
        row.recover = recover
      },
    }
  }

  const $ = {
    command: {
      register: async (command: { name: string }) => ({ command: command.name }),
    },
    env: {
      get: async () => {
        const waiting = gateWait
        if (waiting !== undefined) {
          gateWait = undefined
          waiting.entered()
          await waiting.release
        }

        return undefined
      },
    },
    fs: {
      write: async () => undefined,
      list: async () => [],
    },
    clock: {
      now: async () => 0,
      sleep: async () => undefined,
    },
    session: {
      root: async () => {
        if (options.root === undefined) throw new Error('no project root')

        return options.root
      },
      id: async () => {
        if (options.sessionId === undefined) throw new Error('no session id')

        return options.sessionId
      },
      messages: async () => {
        calls.messages += 1
        throw new Error('no transcript')
      },
    },
    store: {
      get: async (key: string) => {
        if (fail.gets > 0) {
          fail.gets -= 1
          throw new Error('store get failed')
        }

        return store.get(key)
      },
      set: async (key: string, value: unknown) => {
        order.push('set')
        if (fail.sets > 0) {
          fail.sets -= 1
          throw new Error('store set failed')
        }
        store.set(key, JSON.parse(JSON.stringify(value)) as unknown)
      },
      delete: async (key: string) => {
        order.push('delete')
        store.delete(key)
      },
    },
    ui: {
      status: (text: string | undefined) => {
        order.push('status')
        status.push(text)
      },
      log: (text: string) => {
        order.push('log')
        logs.push(text)
      },
      toast: () => {
        throw new Error('popup')
      },
    },
    http: {
      fetch: async () => {
        calls.http += 1
        throw new Error('no network')
      },
    },
    model: {
      complete: async () => {
        calls.model += 1
        throw new Error('no model')
      },
    },
    prompt: {
      submit: async (body: unknown) => {
        prompts.push(body)
        throw new Error('the note must not submit a prompt')
      },
    },
  }

  // The engine always calls register(on, options). This plugin has no userConfig, so options is empty.
  register(on as never, {})

  const dispatch = async (event: string, payload: Record<string, unknown>): Promise<unknown> => {
    const hook = hooks.find(row => row.event === event && matches(row.filter, payload))
    if (hook === undefined) return payload
    const makeNext = (failure: { message: string } | undefined) => {
      const fn = async (inner: Record<string, unknown>) => inner
      // Same shape as the generated catch contract: readonly data, not a function.
      Object.defineProperty(fn, 'error', {
        enumerable: true,
        configurable: false,
        get() {
          errorReads.count += 1

          return failure
        },
      })

      return fn
    }
    const next = makeNext(undefined)
    try {
      return await hook.fn($, payload, next)
    } catch (error) {
      if (hook.recover !== undefined) {
        recovered.count += 1
        const message = error instanceof Error ? error.message : String(error)
        const failure = { message }
        failures.push(failure)

        return hook.recover($, payload, makeNext(failure))
      }
      throw error
    }
  }

  return {
    status,
    logs,
    order,
    recovered,
    failures,
    errorReads,
    fail,
    pauseNextGate,
    calls,
    store,
    prompts,
    dispatch,
  }
}

export const storeToJson = (store: Map<string, unknown>): string => JSON.stringify([...store.entries()])

export const storeFromJson = (text: string): Map<string, unknown> => new Map(JSON.parse(text) as [string, unknown][])
