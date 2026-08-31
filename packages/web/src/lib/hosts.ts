import { useSyncExternalStore } from 'react'
import { WorkerDeckClient, apiUrl, hostAuth, isLoopbackHost } from '@workerdeck/client'

export type GatewayHost = {
  id: string
  name: string
  baseUrl: string
  // The gateway that served this page: not editable, not removable, and credential-free, since its auth is the cookie.
  implicit?: boolean
}

const HOSTS_KEY = 'workerdeck.hosts.v1'
const keyKey = (id: string) => `workerdeck.host.${id}.key`

// The string the single-gateway build used, so watermarks written before this existed keep counting.
export const IMPLICIT_HOST_ID = 'gateway'

type State = {
  hosts: GatewayHost[]
  ready: boolean
}

let state: State = { hosts: [], ready: false }
const listeners = new Set<() => void>()

const emit = (next: State): void => {
  state = next
  clients.clear()
  for (const listener of listeners) {
    listener()
  }
}

const readStored = (): GatewayHost[] => {
  try {
    const raw = localStorage.getItem(HOSTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as GatewayHost[]) : []
    // Never trust a stored `implicit`: the probe decides it, and a hand-edited entry claiming it has no credential path.
    return Array.isArray(parsed) ? parsed.map(({ implicit: _, ...h }) => h) : []
  } catch {
    return []
  }
}

const persist = (hosts: GatewayHost[]): void => {
  try {
    localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.filter((h) => !h.implicit)))
  } catch {}
}

// Not `crypto.randomUUID()`: it is gated on a secure context, so it is undefined on exactly the deployment this exists
// for — a dashboard served over plain HTTP on a tailnet name. `getRandomValues` carries no such gate.
export const newHostId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const keyFor = (id: string): string => {
  try {
    return localStorage.getItem(keyKey(id)) ?? ''
  } catch {
    return ''
  }
}

const setKey = (id: string, key: string): void => {
  try {
    if (key === '') {
      localStorage.removeItem(keyKey(id))
    } else {
      localStorage.setItem(keyKey(id), key)
    }
  } catch {}
}

const clients = new Map<string, WorkerDeckClient>()

// One client per host id: two for one gateway would open two sockets and split the tool bridge's "first attached client".
export const clientFor = (hostId: string): WorkerDeckClient | undefined => {
  const cached = clients.get(hostId)
  if (cached) {
    return cached
  }
  const host = state.hosts.find((h) => h.id === hostId)
  if (!host) {
    return undefined
  }
  const base = apiUrl(host)
  if (base === undefined) {
    return undefined
  }
  const client = new WorkerDeckClient({
    baseUrl: base,
    ...(host.implicit ? {} : hostAuth({ baseUrl: base, key: keyFor(host.id) })),
  })
  clients.set(hostId, client)
  return client
}

export const hostById = (id: string): GatewayHost | undefined => state.hosts.find((h) => h.id === id)

export const primaryHost = (): GatewayHost | undefined => state.hosts.find((h) => h.implicit) ?? state.hosts[0]

export const primaryClient = (): WorkerDeckClient | undefined => {
  const host = primaryHost()
  return host ? clientFor(host.id) : undefined
}

export const isLocal = (host: GatewayHost): boolean => isLoopbackHost(host)

export const saveHost = (host: GatewayHost, key: string): void => {
  const stored = readStored()
  const next = stored.some((h) => h.id === host.id) ? stored.map((h) => (h.id === host.id ? host : h)) : [...stored, host]
  persist(next)
  setKey(host.id, key)
  emit({ ...state, hosts: [...state.hosts.filter((h) => h.implicit), ...next] })
}

export const removeHost = (id: string): void => {
  const next = readStored().filter((h) => h.id !== id)
  persist(next)
  setKey(id, '')
  emit({ ...state, hosts: [...state.hosts.filter((h) => h.implicit), ...next] })
}

// The *shape* of `/auth/status` is checked, not just the status: "it replied 200" is not "it is a gateway".
const probeOrigin = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${location.origin}/auth/status`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      return false
    }
    if (!res.headers.get('content-type')?.includes('application/json')) {
      return false
    }
    const body: unknown = await res.json()
    return typeof body === 'object' && body !== null && 'enabled' in body
  } catch {
    return false
  }
}

let started = false

const start = (): void => {
  if (started) {
    return
  }
  started = true
  const stored = readStored()
  // Stored hosts render at once and the implicit one joins when the probe answers, so `ready` is what tells an
  // empty list apart from an unasked question.
  state = { hosts: stored, ready: false }
  void probeOrigin().then((served) => {
    emit({
      hosts: served
        ? [
            {
              id: IMPLICIT_HOST_ID,
              name: 'This gateway',
              baseUrl: location.origin,
              implicit: true,
            },
            ...stored,
          ]
        : stored,
      ready: true,
    })
  })
}

const subscribe = (listener: () => void): (() => void) => {
  start()
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const useHosts = (): State =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )

export const currentHosts = (): GatewayHost[] => {
  start()
  return state.hosts
}

export const onHostsChange = (listener: () => void): (() => void) => subscribe(listener)
