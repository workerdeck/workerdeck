import * as vscode from 'vscode'
import type { SessionInfo } from '@workerdeck/protocol'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor, probe, type ProbeResult } from './gateway.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'

type HostSnapshot =
  | { probe: 'connected'; sessions: SessionInfo[] }
  | { probe: 'unauthorized' }
  | { probe: 'unreachable' }

const POLL_MS = 5000

/**
 * The extension host's picture of every gateway's sessions: REST rollups on a
 * poll (~5s while the sidebar is visible), never a WS attach — the agent panel
 * owns the one live attach per session. Consumers subscribe to `onDidChange`
 * and read `sidebarState()`.
 */
export class SessionsModel implements vscode.Disposable {
  readonly #store: HostStore
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#onDidChange.event
  readonly #snapshots = new Map<string, HostSnapshot>()
  #selected: { hostId: string; sessionId: string } | undefined
  #timer: NodeJS.Timeout | undefined
  #refreshing = false

  constructor(store: HostStore) {
    this.#store = store
    store.onDidChange(() => void this.refresh())
  }

  setSelected(selected: { hostId: string; sessionId: string } | undefined): void {
    this.#selected = selected
    this.#onDidChange.fire()
  }

  startPolling(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.refresh(), POLL_MS)
    void this.refresh()
  }

  stopPolling(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      const hosts = this.#store.all()
      await Promise.all(
        hosts.map(async (host) => {
          const client = await clientFor(this.#store, host)
          if (!client) {
            this.#snapshots.set(host.id, { probe: 'unreachable' })
            return
          }
          try {
            const sessions = await client.listSessions()
            // Most recent activity first — the session being steered is the one
            // touched last.
            sessions.sort(
              (a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt),
            )
            this.#snapshots.set(host.id, { probe: 'connected', sessions })
          } catch {
            const result: ProbeResult = await probe(client)
            this.#snapshots.set(
              host.id,
              result === 'connected' ? { probe: 'connected', sessions: [] } : { probe: result },
            )
          }
        }),
      )
      // Deleting the current key during Map iteration is defined behavior.
      for (const id of this.#snapshots.keys()) {
        if (!hosts.some((h) => h.id === id)) this.#snapshots.delete(id)
      }
      this.#onDidChange.fire()
    } finally {
      this.#refreshing = false
    }
  }

  sessionsOf(hostId: string): SessionInfo[] {
    const snap = this.#snapshots.get(hostId)
    return snap?.probe === 'connected' ? snap.sessions : []
  }

  /** Sessions awaiting a human — the sidebar view badge. */
  attentionCount(): number {
    let waiting = 0
    for (const snap of this.#snapshots.values()) {
      if (snap.probe !== 'connected') continue
      for (const s of snap.sessions) {
        if (s.pendingPermissionCount > 0 || s.status === 'awaiting_approval') waiting += 1
      }
    }
    return waiting
  }

  sidebarState(workspaceFolder: string | undefined): SidebarState {
    const hosts: WireHost[] = []
    const sessions: SidebarState['sessions'] = {}
    for (const host of this.#store.all()) {
      const base = apiUrl(host)
      if (!base) continue
      const snap = this.#snapshots.get(host.id)
      const local = isLoopbackHost(host)
      hosts.push({
        id: host.id,
        name: host.name,
        baseUrl: base,
        rawUrl: host.baseUrl,
        local,
        probe: snap?.probe ?? 'pending',
        cwdSuggestion: local ? workspaceFolder : this.sessionsOf(host.id)[0]?.cwd,
      })
      if (snap?.probe === 'connected') sessions[host.id] = snap.sessions
    }
    return { hosts, sessions, selected: this.#selected }
  }

  hostOf(hostId: string): GatewayHost | undefined {
    return this.#store.get(hostId)
  }

  dispose(): void {
    this.stopPolling()
    this.#onDidChange.dispose()
  }
}
