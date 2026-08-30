import { useSyncExternalStore } from 'react'
import { WorkerDeckClient, apiUrl, hostAuth, isLoopbackHost } from '@workerdeck/client'

/**
 * The gateways this dashboard talks to — the mirror of `apps/vscode/src/hosts.ts`
 * and iOS's `HostStore`, with the difference a browser forces: no SecretStorage,
 * so an added gateway's key lives in `localStorage` where any script on this
 * origin can read it. The **implicit** host (the gateway that served this page)
 * therefore stores no key at all: same origin, so the HttpOnly login cookie rides
 * its REST *and* its upgrades. `docs/PACKAGES.md` §packages/web has the full shape.
 */
export type GatewayHost = {
  id: string
  name: string
  /** What the operator typed. `apiUrl()` turns it into the API root. */
  baseUrl: string
  /**
   * True for the gateway that served this page. Not editable, not removable,
   * and credential-free — its auth is the cookie it already set.
   */
  implicit?: boolean
}

const HOSTS_KEY = 'workerdeck.hosts.v1'
const keyKey = (id: string) => `workerdeck.host.${id}.key`

/**
 * The implicit host's id is the string the single-gateway build already used,
 * so every watermark written before this existed keeps counting against the
 * same gateway instead of resetting to unread.
 */
export const IMPLICIT_HOST_ID = 'gateway'

type State = {
  hosts: GatewayHost[]
  /** False until the same-origin probe has answered — the list is not yet final. */
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
    // Never trust a stored `implicit`: that flag is decided by the probe, and a
    // hand-edited entry claiming it would be a host with no credential path.
    return Array.isArray(parsed) ? parsed.map(({ implicit: _, ...h }) => h) : []
  } catch {
    return []
  }
}

const persist = (hosts: GatewayHost[]): void => {
  try {
    localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.filter((h) => !h.implicit)))
  } catch {
    /* private mode — the list holds for this page only */
  }
}

/**
 * **Not `crypto.randomUUID()`**: it is gated on a secure context, so it is
 * `undefined` on exactly the deployment this feature exists for — a dashboard
 * served over plain HTTP on a Tailscale name. `getRandomValues` carries no such
 * gate, and uniqueness within this browser is the whole requirement.
 */
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
  } catch {
    /* private mode */
  }
}

// ── clients ────────────────────────────────────────────────────────────────

const clients = new Map<string, WorkerDeckClient>()

/**
 * One client per host id. Cached because two clients for one gateway would open
 * two sockets and split the tool bridge's "first attached client" between them.
 * Cleared whenever the host list changes: an edited address or key is a different client.
 */
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
    // The implicit host authenticates with the cookie the gateway set, which rides on its own.
    ...(host.implicit ? {} : hostAuth({ baseUrl: base, key: keyFor(host.id) })),
  })
  clients.set(hostId, client)
  return client
}

export const hostById = (id: string): GatewayHost | undefined => state.hosts.find((h) => h.id === id)

/**
 * The gateway answering for surfaces that are not (yet) per-gateway: jobs,
 * profiles, the create form's pickers. Implicit host when there is one, else the
 * first configured. Named rather than implied — anything calling this is *choosing*
 * a gateway, and should say so in its UI when the choice could surprise someone.
 */
export const primaryHost = (): GatewayHost | undefined => state.hosts.find((h) => h.implicit) ?? state.hosts[0]

export const primaryClient = (): WorkerDeckClient | undefined => {
  const host = primaryHost()
  return host ? clientFor(host.id) : undefined
}

/** Decided from the URL, never by probing paths — the rule `isLoopbackHost` keeps identical across clients. */
export const isLocal = (host: GatewayHost): boolean => isLoopbackHost(host)

// ── mutations ──────────────────────────────────────────────────────────────

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

// ── discovery ──────────────────────────────────────────────────────────────

/**
 * Is this page being served *by* a gateway? The **shape** of `/auth/status` is
 * checked, not just the status: a generic static host answers anything with
 * `200 text/html`, and "it replied" is not "it is a gateway".
 */
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
  // Stored hosts render immediately; the implicit one joins when the probe answers. `ready`
  // is what tells an empty list apart from an unasked question.
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

/** Snapshot for non-React callers (the sessions poll). */
export const currentHosts = (): GatewayHost[] => {
  start()
  return state.hosts
}

/** Subscribe outside React — the sessions store re-polls when gateways change. */
export const onHostsChange = (listener: () => void): (() => void) => subscribe(listener)
