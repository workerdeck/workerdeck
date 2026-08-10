import { WebSocket as NodeWebSocket } from 'ws'
import { WorkerDeckClient } from '@workerdeck/client'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl } from './hosts.ts'

/**
 * Extension-host-side clients: real Node fetch with the gateway's auth header.
 *
 * `WebSocketImpl` must be passed even though the extension host never attaches
 * a session (live truth belongs to the panel, rollups to the sidebar — one
 * attach per session): the client resolves its WS implementation at
 * construction, and VS Code's Node 18 has no global `WebSocket`.
 */
export async function clientFor(store: HostStore, host: GatewayHost): Promise<WorkerDeckClient | undefined> {
  const base = apiUrl(host)
  if (!base) return undefined
  const headers = await store.authHeaders(host.id)
  return new WorkerDeckClient({
    baseUrl: base,
    headers,
    fetchImpl: fetch,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
  })
}

export type ProbeResult = 'connected' | 'unauthorized' | 'unreachable'

/** One cheap authenticated GET decides all three states. */
export async function probe(client: WorkerDeckClient): Promise<ProbeResult> {
  try {
    await client.listSessions()
    return 'connected'
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 401 || status === 403) return 'unauthorized'
    return 'unreachable'
  }
}
