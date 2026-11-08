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
 * to imitate a second session on one machine-wide store.
 */
export const install = (options: {
  root?: string
  sessionId?: string
  store?: Map<string, unknown>
}): Installed => {
  const store = options.store ?? new Map<string, unknown>()
  const status: (string | undefined)[] = []
  const logs: string[] = []
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
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)) as unknown)
      },
      delete: async (key: string) => {
        store.delete(key)
      },
    },
    ui: {
      status: (text: string | undefined) => {
        status.push(text)
      },
      log: (text: string) => {
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

  register(on as never)

  const dispatch = async (event: string, payload: Record<string, unknown>): Promise<unknown> => {
    const hook = hooks.find(row => row.event === event && matches(row.filter, payload))
    if (hook === undefined) return payload
    const next = async (inner: Record<string, unknown>) => inner
    try {
      return await hook.fn($, payload, next)
    } catch (error) {
      if (hook.recover !== undefined) return hook.recover($, payload, next)
      throw error
    }
  }

  return { status, logs, calls, store, prompts, dispatch }
}

export const storeToJson = (store: Map<string, unknown>): string => JSON.stringify([...store.entries()])

export const storeFromJson = (text: string): Map<string, unknown> => new Map(JSON.parse(text) as [string, unknown][])
