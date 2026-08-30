import * as vscode from 'vscode'
import type { SessionInfo } from '@workerdeck/protocol'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor, probe, type ProbeResult } from './gateway.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'
import { workspaceScope } from './workspace-scope.ts'

type HostSnapshot = { probe: 'connected'; sessions: SessionInfo[] } | { probe: 'unauthorized' } | { probe: 'unreachable' }

/**
 * The list cannot ride the live socket — the agent panel owns the one attach a
 * session gets, and the tool bridge asks the *first* attached client — so it polls,
 * tightening while anything is running or waiting on a human.
 */
const POLL_IDLE_MS = 5000
const POLL_BUSY_MS = 1200

/**
 * The extension host's picture of every gateway's sessions: REST rollups on a poll
 * while any view that renders them is visible (`setWatching`), never a WS attach.
 * Consumers subscribe to `onDidChange` and read `sidebarState()`.
 */
export class SessionsModel implements vscode.Disposable {
  readonly #store: HostStore
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#onDidChange.event
  readonly #snapshots = new Map<string, HostSnapshot>()
  #selected: SidebarState['selected']
  #timer: NodeJS.Timeout | undefined
  /** The interval the running timer was started with, so a change can restart it. */
  #timerMs: number | undefined
  /** Views that currently want fresh readings — see `setWatching`. */
  readonly #watchers = new Set<string>()
  #refreshing = false
  /** A coalescing timer for `nudge`. */
  #nudge: NodeJS.Timeout | undefined
  readonly #folders: vscode.Disposable

  /** Supplied by `activate`: turns-since-last-seen per session. The model owns
   * no watermarks itself — it is the poll, not the memory of what was read. */
  #unseen: ((sessions: SidebarState['sessions']) => Record<string, number>) | undefined

  constructor(store: HostStore) {
    this.#store = store
    store.onDidChange(() => void this.refresh())
    // The open folders are part of the state consumers render, so a change has to reach them without a poll.
    this.#folders = vscode.workspace.onDidChangeWorkspaceFolders(() => this.#onDidChange.fire())
  }

  setSelected(selected: SidebarState['selected']): void {
    this.#selected = selected
    this.#onDidChange.fire()
  }

  /**
   * Which sub-agent the panel has framed, reported by the panel itself. A separate
   * setter from `setSelected` because the two facts have different owners and
   * lifetimes: the selected session is this window's and survives a reload, the
   * frame belongs to the panel and dies with it. A report with no session selected
   * is dropped — holding it would hand the next session a frame it never opened.
   */
  setSelectedSubagent(toolUseId: string | undefined): void {
    if (!this.#selected) {
      return
    }
    if (this.#selected.subagentToolUseId === toolUseId) {
      return
    }
    this.#selected = { ...this.#selected, subagentToolUseId: toolUseId }
    this.#onDidChange.fire()
  }

  /**
   * Report whether a view needs fresh readings. A set, not a boolean: several
   * independently collapsible views render this state, and gating the poll on one
   * of them leaves the others showing probes frozen at `pending`. Cheap to call
   * repeatedly; only the first and last watcher move the timer.
   */
  setWatching(key: string, watching: boolean): void {
    const before = this.#watchers.size
    if (watching) {
      this.#watchers.add(key)
    } else {
      this.#watchers.delete(key)
    }
    if (this.#watchers.size > 0 && before === 0) {
      this.#startPolling()
    } else if (this.#watchers.size === 0 && before > 0) {
      this.#stopPolling()
    }
  }

  #startPolling(): void {
    if (this.#timer) {
      return
    }
    this.#retime()
    void this.refresh()
  }

  #stopPolling(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
    }
    this.#timer = undefined
    this.#timerMs = undefined
  }

  /** Point the timer at the rate the current state deserves. A no-op unless the
   * rate actually changed, so it is safe to call after every refresh. */
  #retime(): void {
    const wanted = this.#busy() ? POLL_BUSY_MS : POLL_IDLE_MS
    if (this.#timer && this.#timerMs === wanted) {
      return
    }
    if (this.#timer) {
      clearInterval(this.#timer)
    }
    this.#timerMs = wanted
    this.#timer = setInterval(() => void this.refresh(), wanted)
  }

  /** Is anything worth watching closely? */
  #busy(): boolean {
    for (const snap of this.#snapshots.values()) {
      if (snap.probe !== 'connected') {
        continue
      }
      for (const s of snap.sessions) {
        if (s.status === 'running' || s.status === 'starting') {
          return true
        }
        if (s.pendingPermissionCount > 0 || s.status === 'awaiting_approval') {
          return true
        }
      }
    }
    return false
  }

  /**
   * Something just happened that the rollups do not know about yet — refresh now
   * rather than on the next tick. Called by the agent panel off its own socket, and
   * coalesced: the point is to collapse the delay to one round-trip, not to poll
   * per frame.
   */
  nudge(): void {
    if (!this.#timer || this.#nudge) {
      return
    }
    this.#nudge = setTimeout(() => {
      this.#nudge = undefined
      void this.refresh()
    }, 150)
  }

  async refresh(): Promise<void> {
    if (this.#refreshing) {
      return
    }
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
            // Most recent activity first — the session being steered is the one touched last.
            sessions.sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
            this.#snapshots.set(host.id, { probe: 'connected', sessions })
          } catch {
            const result: ProbeResult = await probe(client)
            this.#snapshots.set(host.id, result === 'connected' ? { probe: 'connected', sessions: [] } : { probe: result })
          }
        }),
      )
      // Deleting the current key during Map iteration is defined behavior.
      for (const id of this.#snapshots.keys()) {
        if (!hosts.some((h) => h.id === id)) {
          this.#snapshots.delete(id)
        }
      }
      this.#onDidChange.fire()
      // A turn that just started (or ended) changes what the right rate is.
      if (this.#timer) {
        this.#retime()
      }
    } finally {
      this.#refreshing = false
    }
  }

  sessionsOf(hostId: string): SessionInfo[] {
    const snap = this.#snapshots.get(hostId)
    return snap?.probe === 'connected' ? snap.sessions : []
  }

  /** Sessions awaiting a human — what colours the unread status-bar item. */
  attentionCount(): number {
    let waiting = 0
    for (const snap of this.#snapshots.values()) {
      if (snap.probe !== 'connected') {
        continue
      }
      for (const s of snap.sessions) {
        if (s.pendingPermissionCount > 0 || s.status === 'awaiting_approval') {
          waiting += 1
        }
      }
    }
    return waiting
  }

  sidebarState(): SidebarState {
    const scope = workspaceScope()
    const hosts: WireHost[] = []
    const sessions: SidebarState['sessions'] = {}
    for (const host of this.#store.all()) {
      const base = apiUrl(host)
      if (!base) {
        continue
      }
      const snap = this.#snapshots.get(host.id)
      const local = isLoopbackHost(host)
      // The open folder is a guess only where this gateway could chdir into it: its own mount,
      // or any folder when the gateway runs on this machine. Otherwise, where its sessions live.
      const folder = scope?.roots.find((r) => (r.hostId ? r.hostId.toLowerCase() === host.id.toLowerCase() : local))?.path
      hosts.push({
        id: host.id,
        name: host.name,
        baseUrl: base,
        rawUrl: host.baseUrl,
        local,
        probe: snap?.probe ?? 'pending',
        cwdSuggestion: folder ?? this.sessionsOf(host.id)[0]?.cwd,
      })
      if (snap?.probe === 'connected') {
        sessions[host.id] = snap.sessions
      }
    }
    return { hosts, sessions, selected: this.#selected, scope, unseen: this.#unseen?.(sessions) }
  }

  setUnseenProvider(provider: (sessions: SidebarState['sessions']) => Record<string, number>): void {
    this.#unseen = provider
  }

  hostOf(hostId: string): GatewayHost | undefined {
    return this.#store.get(hostId)
  }

  dispose(): void {
    if (this.#nudge) {
      clearTimeout(this.#nudge)
    }
    this.#stopPolling()
    this.#folders.dispose()
    this.#onDidChange.dispose()
  }
}
