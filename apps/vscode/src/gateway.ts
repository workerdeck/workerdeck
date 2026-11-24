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
    // Required even though the host never attaches: the client resolves its WS impl at construction and Node 18 has no global `WebSocket`.
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
  })
}

export type ProbeResult = 'connected' | 'unauthorized' | 'unreachable'

export async function probe(client: WorkerDeckClient): Promise<ProbeResult> {
  try {
    await client.listSessions()
    return 'connected'
  } catch (err) {
    return probeFailure(err)
  }
}

export function probeFailure(err: unknown): Exclude<ProbeResult, 'connected'> {
  const status = (err as { status?: number }).status
  return status === 401 || status === 403 ? 'unauthorized' : 'unreachable'
}
