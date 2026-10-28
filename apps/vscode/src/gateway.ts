import { WebSocket as NodeWebSocket } from 'ws'
import { WorkerDeckClient } from '@workerdeck/client'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl } from './hosts.ts'

// One client per gateway, kept while its address and auth hold: a client learns each session's conversation from the
// lists and attaches it has seen, and every mutating session call must name it (protocol 2), so a fresh client per
// action would send none and be refused.
const clients = new Map<string, { key: string; client: WorkerDeckClient | undefined }>()

export async function clientFor(store: HostStore, host: GatewayHost): Promise<WorkerDeckClient | undefined> {
  const headers = await store.authHeaders(host.id)
  const key = JSON.stringify([host.baseUrl, headers])
  const held = clients.get(host.id)
  if (held?.key === key) {
    return held.client
  }
  const client = clientForUrl(host.baseUrl, headers)
  clients.set(host.id, { key, client })
  return client
}

export function clientForUrl(baseUrl: string, headers: Record<string, string>): WorkerDeckClient | undefined {
  const base = apiUrl({ baseUrl })
  if (!base) {
    return undefined
  }
  return new WorkerDeckClient({
    baseUrl: base,
    headers,
    fetchImpl: fetch,
    // Node 18 has no global `WebSocket`, and a browser-shaped constructor cannot carry the auth header.
    WebSocketImpl: socketWithHeaders(headers),
  })
}

function socketWithHeaders(headers: Record<string, string>): typeof WebSocket {
  class AuthedWebSocket extends NodeWebSocket {
    constructor(url: string) {
      super(url, { headers })
    }
  }
  return AuthedWebSocket as unknown as typeof WebSocket
}

export type HostLoader<S> = (host: GatewayHost, client: WorkerDeckClient | undefined) => Promise<S>

export type ProbeResult = 'connected' | 'unauthorized' | 'unreachable'

export async function probe(client: WorkerDeckClient): Promise<ProbeResult> {
  try {
    await client.listSessions()
    return 'connected'
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 401 || status === 403) {
      return 'unauthorized'
    }
    return 'unreachable'
  }
}

// One snapshot per gateway, keyed by host id. A gateway gone from the store loses its entry, and its id is returned.
export async function refreshPerHost<S>(store: HostStore, snapshots: Map<string, S>, load: HostLoader<S>): Promise<string[]> {
  const hosts = store.all()
  await Promise.all(hosts.map(async (host) => snapshots.set(host.id, await load(host, await clientFor(store, host)))))
  const gone = [...snapshots.keys()].filter((id) => !hosts.some((h) => h.id === id))
  for (const id of gone) {
    snapshots.delete(id)
  }
  return gone
}
