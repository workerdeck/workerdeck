/**
 * The postMessage wires between the two webviews and the extension host.
 *
 * Both webviews run real `WorkerDeckClient`s — the transport messages carry
 * their injected `fetchImpl`/`WebSocketImpl` across the process boundary, and
 * the extension host executes them with Node fetch / `ws`, adding the
 * gateway's `Authorization` header there. Keys never enter a webview; neither
 * webview CSP has an external `connect-src`.
 *
 * Surfaces (see the PRD's design): the **agent panel** is purely the
 * conversation (`SessionPanel` with `panelSurface: 'external'` — no dialogs);
 * the **sidebar** owns management — session list, push-view forms, and the
 * scoped Info/Context/Usage/MCP sections, fed by REST plus the vitals the
 * panel relays (the panel holds the one live attach; the sidebar must never
 * attach a second time).
 *
 * Dependency-free at runtime (type-only imports, erased at build). Imported by
 * BOTH tsconfigs: keep it to types and constants.
 */
import type { SessionInfo } from '@workerdeck/protocol'
import type { SessionSurfacePanel, SessionVitals } from '@workerdeck/ui'

/** A gateway as the webviews see it (no credentials — those stay host-side). */
export type WireHost = {
  id: string
  name: string
  /** REST base including /v1 — what a webview client gets as baseUrl. */
  baseUrl: string
  /** Raw operator-typed URL, for the gateway edit form. */
  rawUrl: string
  /** Loopback → session cwds are paths on this machine. */
  local: boolean
  probe: 'connected' | 'unauthorized' | 'unreachable' | 'pending'
  /** Best guess for a new session's cwd on this host. */
  cwdSuggestion?: string
}

/**
 * One folder open in this window, as a place sessions can live in.
 *
 * `hostId` present = the folder is a `workerdeck://<hostId>` mount, so only that
 * gateway's sessions can be inside it. Absent = a real local folder, which only
 * a loopback gateway's cwds can be inside: a remote gateway's paths are on
 * another machine, where an identical-looking path means nothing.
 */
export type ScopeRoot = { hostId?: string; path: string }

/** The window's open folders — the sessions list's intrinsic scope. */
export type WorkspaceScope = { label: string; roots: ScopeRoot[] }

export type SidebarState = {
  hosts: WireHost[]
  /** Keyed by host id; present only for connected hosts. */
  sessions: Record<string, SessionInfo[]>
  selected?: { hostId: string; sessionId: string }
  /** Absent when no folder is open — the scope filter is then inert. */
  scope?: WorkspaceScope
}

/** Transport messages — either webview → host. */
export type TransportToHost =
  | {
      kind: 'wd-fetch'
      id: number
      url: string
      method: string
      headers: [string, string][]
      bodyB64?: string
    }
  | { kind: 'wd-fetch-abort'; id: number }
  | { kind: 'wd-ws-open'; id: number; url: string }
  | { kind: 'wd-ws-send'; id: number; data: string }
  | { kind: 'wd-ws-close'; id: number; code?: number; reason?: string }

/** Transport messages — host → either webview. */
export type TransportToWebview =
  | {
      kind: 'wd-fetch-result'
      id: number
      ok: true
      status: number
      statusText: string
      headers: [string, string][]
      bodyB64: string
    }
  | { kind: 'wd-fetch-result'; id: number; ok: false; error: string }
  | { kind: 'wd-ws-event'; id: number; event: 'open' }
  | { kind: 'wd-ws-event'; id: number; event: 'message'; data: string }
  | { kind: 'wd-ws-event'; id: number; event: 'close'; code?: number; reason?: string }
  | { kind: 'wd-ws-event'; id: number; event: 'error'; message?: string }

/** Agent panel webview → host. */
export type PanelToHost =
  | TransportToHost
  | { kind: 'wd-ready' }
  | { kind: 'wd-open-path'; path: string; line?: number }
  | {
      /** SessionPanel's onVitals, relayed onward to the sidebar's scoped panels. */
      kind: 'wd-vitals'
      vitals: SessionVitals
    }
  | {
      /** SessionPanel's onOpenPanel (status-bar clicks, `/mcp`) — the sidebar
       * hosts the surface, so the intent travels there via the host. */
      kind: 'wd-open-panel'
      panel: SessionSurfacePanel
    }

/** Host → agent panel webview. */
export type HostToPanel =
  | TransportToWebview
  | {
      kind: 'wd-show-session'
      session?: { baseUrl: string; sessionId: string; hostName: string }
    }

/** Sidebar webview → host. */
export type SidebarToHost =
  | TransportToHost
  | { kind: 'wd-ready' }
  | { kind: 'wd-refresh' }
  | { kind: 'wd-select-session'; hostId: string; sessionId: string }
  | {
      /** Interrupt. Executed host-side over a transient attach. */
      kind: 'wd-stop-session'
      hostId: string
      sessionId: string
    }
  | { kind: 'wd-delete-session'; hostId: string; sessionId: string }
  | {
      /** Rename. Empty string clears the name, restoring the derived title. */
      kind: 'wd-rename-session'
      hostId: string
      sessionId: string
      title: string
    }
  | {
      /** Save a gateway (id present = edit). Key goes straight to the keychain. */
      kind: 'wd-submit-gateway'
      id?: string
      name: string
      baseUrl: string
      authKey: string
    }
  | { kind: 'wd-remove-gateway'; hostId: string }
  | {
      /** Ask for the gateway edit screen — the host answers with wd-navigate,
       * key prefilled from the keychain (the webview cannot read it itself). */
      kind: 'wd-edit-gateway'
      hostId: string
    }
  | {
      /** The new-session form created the session itself (its own bridged
       * client) — this just selects it into the agent panel. */
      kind: 'wd-session-created'
      hostId: string
      sessionId: string
    }

/** Host → sidebar webview. */
export type HostToSidebar =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | {
      /** Push a screen (view-title buttons, palette commands, tree parity). */
      kind: 'wd-navigate'
      screen: 'new-session' | 'gateway' | 'gateways'
      /** gateway screen: prefill for an edit (authKey from the keychain). */
      gateway?: { id: string; name: string; baseUrl: string; authKey: string }
      /** new-session screen: preselect this host. */
      hostId?: string
    }
  | { kind: 'wd-form-result'; ok: boolean; error?: string }
  | {
      /** Show/hide the view config (search, filters, group, sort) — the header
       * icon lives in VS Code's view title, so the toggle arrives from there. */
      kind: 'wd-toggle-view-config'
    }
  | {
      /** Live vitals for the SELECTED session, relayed from the agent panel.
       * Absent vitals = selection changed and no reading exists yet. */
      kind: 'wd-vitals'
      vitals?: SessionVitals
    }

/** Section view (Session Info / Context / Usage / MCP) → host. */
export type SectionToHost = TransportToHost | { kind: 'wd-ready' }

/** Host → section view. State + vitals ride the same shapes the sidebar gets. */
export type HostToSection =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | { kind: 'wd-vitals'; vitals?: SessionVitals }

export type WebviewToHost = PanelToHost | SidebarToHost | SectionToHost
export type HostToWebview = HostToPanel | HostToSidebar | HostToSection
