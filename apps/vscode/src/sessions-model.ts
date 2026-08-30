import * as vscode from 'vscode'
import type { SessionInfo } from '@workerdeck/protocol'
import type { GatewayHost, HostStore } from './hosts.ts'
import { apiUrl, isLoopbackHost } from './hosts.ts'
import { clientFor, probe, type ProbeResult } from './gateway.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'
import { workspaceScope } from './workspace-scope.ts'

type HostSnapshot = { probe: 'connected'; sessions: SessionInfo[] } | { probe: 'unauthorized' } | { probe: 'unreachable' }

/**
 * How often the rollups are re-fetched, and why it is two numbers.
 *
 * The list cannot ride the live socket: the agent panel owns the one attach a
 * session gets (the tool bridge asks the *first* attached client), so a second
 * one here would break it. That leaves polling — and a flat 5s meant "started
 * working" and "finished" could take five seconds to show up in the cards, which
 * reads as the extension being asleep.
 *
 * So the poll follows the work: while anything is running or waiting on a human,
 * it tightens. An idle window is back to 5s and costs a request per gateway.
 * `nudge()` covers the rest — the panel sees the *real* transition on its socket
 * and says so, which is what makes the active session feel immediate.
 */
const POLL_IDLE_MS = 5000
const POLL_BUSY_MS = 1200

/**
 * The extension host's picture of every gateway's sessions: REST rollups on a
 * poll (~5s while any view that renders them is visible — see `setWatching`),
 * never a WS attach — the agent panel
 * owns the one live attach per session. Consumers subscribe to `onDidChange`
 * and read `sidebarState()`.
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
    // The open folders are part of the state consumers render (the scope
    // filter, the cwd suggestion), so a folder added or removed has to reach
    // them — no gateway poll is involved.
    this.#folders = vscode.workspace.onDidChangeWorkspaceFolders(() => this.#onDidChange.fire())
  }

  setSelected(selected: SidebarState['selected']): void {
    this.#selected = selected
    this.#onDidChange.fire()
  }

  /**
   * Which sub-agent the panel has framed, reported by the panel itself.
   *
   * A **separate setter** rather than another `setSelected` call, because the
   * two facts have different owners and different lifetimes: which session is
   * selected is this window's decision and survives a reload
   * (`ACTIVE_SESSION_KEY`), while which agent is framed belongs to the panel and
   * dies with it. Folding them into one call meant every panel report had to
   * restate the session, and a report that raced a session switch would have
   * restated the *old* one.
   *
   * A report with no session selected is dropped rather than stored: there is
   * nothing for it to qualify, and holding it would mean the next session
   * selected inherited a frame it never opened.
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
   * Report whether a view needs fresh readings. Polling runs while **any** of
   * them does, which is why this is a set and not a boolean: more than one view
   * renders this state now (the sessions list and the Gateways view), each
   * collapsible on its own, and gating the poll on one of them meant the other
   * could sit showing probes frozen at `pending` — the very thing it exists to
   * report. Cheap to call repeatedly; only the first and last watcher move the
   * timer, and gaining the first also refreshes at once.
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
   * rather than on the next tick.
   *
   * The caller is the agent panel, which sees the session's real events on its
   * own socket. Coalesced on a short window because a turn produces a great many
   * of them and each refresh is a request per gateway; the point is to collapse
   * the delay from "up to a poll" to "one round-trip", not to poll per frame.
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
            // Most recent activity first — the session being steered is the one
            // touched last.
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
      // The open folder is the best guess only where it is a path this gateway
      // could chdir into: its own mount, or any folder at all when the gateway
      // runs on this machine. Otherwise fall back to where its sessions live.
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
