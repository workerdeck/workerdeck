import { WebSocket as NodeWebSocket } from 'ws'
import { WorkerDeckClient } from '@workerdeck/client'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl } from './hosts.ts'

export async function clientFor(store: HostStore, host: GatewayHost): Promise<WorkerDeckClient | undefined> {
  return clientForUrl(host.baseUrl, await store.authHeaders(host.id))
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
    const status = (err as { status?: number }).status
    if (status === 401 || status === 403) {
      return 'unauthorized'
    }
    return 'unreachable'
  }
}
