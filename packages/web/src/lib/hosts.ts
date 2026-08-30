import { useSyncExternalStore } from 'react'
import { WorkerDeckClient, apiUrl, hostAuth, isLoopbackHost } from '@workerdeck/client'

/**
 * The gateways this dashboard talks to.
 *
 * The mirror of `apps/vscode/src/hosts.ts` and iOS's `HostStore`, with the one
 * difference a browser forces: there is no SecretStorage or Keychain here, so a
 * gateway key lives in `localStorage` beside the watermarks. Anyone who can run
 * script on this origin can read it — which is the honest cost of a dashboard
 * that reaches more than the server that served it, and is why the gateway it
 * *was* served by never needs a key at all (see the implicit host below).
 *
 * Two kinds of host, and the difference is which credential they can use:
 *
 * - The **implicit host** is the gateway that served this page. It is same
 *   origin, so the HttpOnly login cookie rides its REST calls *and* its WS
 *   upgrades automatically: no key is stored, and none can be entered. It is
 *   discovered rather than assumed — a standalone build served from anywhere
 *   else has no such gateway and starts with an empty list, the way the VS Code
 *   extension refuses to invent a localhost entry.
 * - **Added hosts** are typed in by the operator with the gateway's key. Cross
 *   origin, so the cookie is not theirs; `hostAuth()` puts the key on REST as a
 *   header and on the WS upgrade as `?key=`.
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

function emit(next: State) {
  state = next
  clients.clear()
  for (const listener of listeners) {
    listener()
  }
}

function readStored(): GatewayHost[] {
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

function persist(hosts: GatewayHost[]) {
  try {
    localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts.filter((h) => !h.implicit)))
  } catch {
    /* private mode — the list holds for this page only */
  }
}

/**
 * An id for a newly added gateway.
 *
 * **Not `crypto.randomUUID()`**, which is gated on a secure context and is
 * therefore `undefined` on exactly the deployment this whole multi-gateway
 * feature exists for: a dashboard served over plain HTTP on a Tailscale name.
 * (`localhost` is treated as secure, which is why it only breaks off the
 * machine.) `crypto.getRandomValues` carries no such gate, so the v4 is built
 * from it and `randomUUID` is used only where it happens to exist.
 *
 * The id is a local key for a localStorage record — uniqueness within this
 * browser is the entire requirement.
 */
export function newHostId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 1
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function keyFor(id: string): string {
  try {
    return localStorage.getItem(keyKey(id)) ?? ''
  } catch {
    return ''
  }
}

function setKey(id: string, key: string) {
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
 * The client for a gateway, one per host id.
 *
 * Cached because two clients for one gateway would open two sockets and split
 * the tool bridge's "first attached client" between them — the same reason the
 * watermarks are one module-scope instance. Cleared whenever the host list
 * changes, since an edited address or key is a different client.
 */
export function clientFor(hostId: string): WorkerDeckClient | undefined {
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
    // The implicit host authenticates with the cookie the gateway set, which
    // rides same-origin requests on its own. Spreading an empty key here would
    // be harmless but says the wrong thing.
    ...(host.implicit ? {} : hostAuth({ baseUrl: base, key: keyFor(host.id) })),
  })
  clients.set(hostId, client)
  return client
}

export function hostById(id: string): GatewayHost | undefined {
  return state.hosts.find((h) => h.id === id)
}

/**
 * The gateway that answers for surfaces which are not (yet) per-gateway: jobs,
 * profiles, and the cwd/profile pickers on the create form.
 *
 * The implicit host when there is one, else the first configured. Named rather
 * than implied, because "the gateway" stopped being a well-defined phrase the
 * moment there could be several — anything calling this is choosing one, and
 * should say so in its UI when the choice could surprise someone.
 */
export function primaryHost(): GatewayHost | undefined {
  return state.hosts.find((h) => h.implicit) ?? state.hosts[0]
}

export function primaryClient(): WorkerDeckClient | undefined {
  const host = primaryHost()
  return host ? clientFor(host.id) : undefined
}

export function isLocal(host: GatewayHost): boolean {
  // Decided from the URL, never by probing paths — the rule `isLoopbackHost`
  // exists to keep identical across clients. The implicit host is loopback only
  // if the address in the bar is: a dashboard served over Tailscale is not.
  return isLoopbackHost(host)
}

// ── mutations ──────────────────────────────────────────────────────────────

export function saveHost(host: GatewayHost, key: string): void {
  const stored = readStored()
  const next = stored.some((h) => h.id === host.id) ? stored.map((h) => (h.id === host.id ? host : h)) : [...stored, host]
  persist(next)
  setKey(host.id, key)
  emit({ ...state, hosts: [...state.hosts.filter((h) => h.implicit), ...next] })
}

export function removeHost(id: string): void {
  const next = readStored().filter((h) => h.id !== id)
  persist(next)
  setKey(id, '')
  emit({ ...state, hosts: [...state.hosts.filter((h) => h.implicit), ...next] })
}

// ── discovery ──────────────────────────────────────────────────────────────

/**
 * Is this page being served *by* a gateway?
 *
 * Asked of `/auth/status`, which the CLI has served since the cookie flow
 * existed and answers even when auth is off. The shape is checked, not just the
 * status: a generic static host answers a 404 page with `200 text/html` for
 * anything, and "it replied" is not the same as "it is a gateway".
 *
 * This is not the "never probe paths" rule being broken. That rule is about
 * deciding whether a *typed* gateway is loopback, which a URL answers on its
 * own. Here there is no URL to reason about — the question is who served this
 * document — and exactly one endpoint can answer it.
 */
async function probeOrigin(): Promise<boolean> {
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

function start() {
  if (started) {
    return
  }
  started = true
  const stored = readStored()
  // Render the stored hosts immediately; the implicit one joins them when the
  // probe answers. `ready` is what tells an empty list apart from an unasked
  // question — offering "add your first gateway" before we know whether we are
  // sitting on one would be wrong for a second.
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

function subscribe(listener: () => void) {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useHosts(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/** Snapshot for non-React callers (the sessions poll). */
export function currentHosts(): GatewayHost[] {
  start()
  return state.hosts
}

/** Subscribe outside React — the sessions store re-polls when gateways change. */
export function onHostsChange(listener: () => void): () => void {
  return subscribe(listener)
}
