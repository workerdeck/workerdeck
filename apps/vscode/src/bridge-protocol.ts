/**
 * The postMessage wires between the webviews and the extension host.
 *
 * The webviews run real `WorkerDeckClient`s: the transport messages carry their
 * injected `fetchImpl`/`WebSocketImpl` across the process boundary, and the host
 * executes them with Node fetch / `ws`, adding the gateway's `Authorization`
 * header there. **Keys never enter a webview**, and no webview CSP has an external
 * `connect-src`.
 *
 * The panel holds the one live attach; the sidebar must never attach a second time.
 *
 * Dependency-free at runtime (type-only imports, erased at build). Imported by
 * BOTH tsconfigs: keep it to types and constants.
 */
import type { PermissionMode, ScopeRoot, SessionInfo, WorkspaceScope } from '@workerdeck/protocol'
import type { ViewConfig } from './view-config.ts'
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

/** The window's open folders as places sessions can live in — the sessions list's
 * intrinsic scope, filled in by `workspaceScope()`. */
export type { ScopeRoot, WorkspaceScope }

export type SidebarState = {
  hosts: WireHost[]
  /** Keyed by host id; present only for connected hosts. */
  sessions: Record<string, SessionInfo[]>
  /**
   * What the agent panel is showing. `subagentToolUseId` — which sub-agent has taken
   * the panel body over — is **reported by the panel, not decided here**: the panel
   * enters and leaves frames the host never asked for, so a value inferred from our
   * own requests would be wrong within one click.
   */
  selected?: { hostId: string; sessionId: string; subagentToolUseId?: string }
  /** Absent when no folder is open — the scope filter is then inert. */
  scope?: WorkspaceScope
  /**
   * Transcript rows since a session was last on screen, keyed
   * `hostId:sessionId` — the gateway's own `SessionInfo.activityCount` minus the
   * window's watermark. Only sessions with something new appear.
   */
  unseen?: Record<string, number>
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
  | { kind: 'wd-open-url'; url: string }
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
  | {
      /**
       * SessionPanel's `onSubagentChange`: which sub-agent the panel now has framed,
       * or `undefined` for the session's own conversation. A *statement*, not the echo
       * of `wd-open-subagent`, which is why it carries no nonce — a state that arrives
       * twice is the same state, where a request that arrives twice is two requests.
       */
      kind: 'wd-subagent-open'
      toolUseId?: string
    }

/** Host → agent panel webview. */
export type HostToPanel =
  | TransportToWebview
  | {
      kind: 'wd-show-session'
      session?: {
        baseUrl: string
        sessionId: string
        hostName: string
        /** What had been seen last time this session was on screen — the panel
         * enters catch-up from it. Absent for a session opened for the first
         * time, which has nothing to catch up on. */
        unseen?: { itemCount: number; since: number }
      }
    }
  | {
      /**
       * Switch the model / permission mode from outside the panel. It has to travel
       * this way round: the panel owns the session's one live attach, so it is the
       * only place a setter exists. `model: undefined` means "the CLI's default".
       */
      kind: 'wd-set-model'
      model?: string
    }
  | { kind: 'wd-set-permission-mode'; mode: PermissionMode }
  | {
      /**
       * Put the caret in the composer. Sent when a session is *chosen* and never on a
       * mere state push — hence an event of its own rather than a field on
       * `wd-show-session`.
       */
      kind: 'wd-focus-composer'
    }
  | {
      /**
       * Frame the sub-agent picked in the sessions list. Carries its own `nonce`
       * because picking the same one twice is two requests and without it the second
       * press is a props-equal no-op. Sent **after** `wd-show-session` when the pick
       * also changed session: an id only means something on the right transcript.
       */
      kind: 'wd-open-subagent'
      toolUseId: string
      nonce: number
    }
  | {
      /**
       * Travel to a tool call without framing anything — where a **task** press in the
       * sessions list lands, as opposed to `wd-open-subagent`'s takeover. Drives
       * `SessionPanel.reveal`, and carries its own nonce for the same reason.
       */
      kind: 'wd-reveal-tool-use'
      toolUseId: string
      nonce: number
    }

/** Sidebar webview → host. */
export type SidebarToHost =
  | TransportToHost
  | { kind: 'wd-ready' }
  | {
      kind: 'wd-select-session'
      hostId: string
      sessionId: string
      /**
       * Set when the click landed on a *sub-agent* under the session: select as
       * normal, then hand the panel over to that agent's own work.
       */
      subagentToolUseId?: string
      /**
       * Set when the click landed on a **task** rather than an agent: select as
       * normal, then travel to the row where that work happened. A sibling of
       * `subagentToolUseId`, not a flag on it, because the two go to different panel
       * APIs — `openSubagent` takes the body over, `reveal` stays on the conversation.
       * Conflating them is how a task came to be framed as an agent, which selects no
       * items and draws an empty agent view.
       */
      revealToolUseId?: string
    }
  | {
      /** Interrupt. Executed host-side over a transient attach. */
      kind: 'wd-stop-session'
      hostId: string
      sessionId: string
    }
  | { kind: 'wd-delete-session'; hostId: string; sessionId: string }
  | {
      /**
       * The card's `⋯`. The menu is a native QuickPick built host-side, and carries
       * no action: the host reads the session's state from the model it already
       * polls, so a stale card cannot offer Stop for a session that just finished.
       */
      kind: 'wd-session-menu'
      hostId: string
      sessionId: string
    }
  | {
      /** Rename (double-click the name). Empty string clears it, restoring the
       * derived title. */
      kind: 'wd-rename-session'
      hostId: string
      sessionId: string
      title: string
    }
  | {
      /** The list's empty states point at gateway management, which is its own
       * view now — the host reveals it (and opens its add form on `add`). */
      kind: 'wd-reveal-gateways'
      add?: boolean
    }
  | {
      /**
       * The sessions list's filter/group/sort, mirrored to the host whenever it
       * changes. The webview stays its owner; the host keeps a copy so the unread
       * count matches the rows the list is actually showing.
       */
      kind: 'wd-view-config'
      config: ViewConfig
    }

/** Host → sidebar webview. */
export type HostToSidebar =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | {
      /**
       * Whether the search-and-filter bar is showing. The **host** owns this: the
       * toggle is a `view/title` action, i.e. a command gated on a context key, and
       * the key has to live where commands do.
       */
      kind: 'wd-filter-open'
      open: boolean
    }
  | {
      /** Live vitals for the SELECTED session, relayed from the agent panel.
       * Absent vitals = selection changed and no reading exists yet. */
      kind: 'wd-vitals'
      vitals?: SessionVitals
    }
  | {
      /**
       * Project icon bytes, as data URLs keyed by the icon's content hash. Its own
       * message rather than a field on `SidebarState` because the state rides the
       * poll and must stay small. Sent once per hash on resolution, and re-sent whole
       * after `wd-ready` — a rebuilt webview has no map left. **Cumulative**: the
       * webview merges rather than replaces, or a later resolution drops earlier icons.
       */
      kind: 'wd-project-icons'
      icons: Record<string, string>
    }

/**
 * Gateways view → host. **No transports**: managing a gateway is entirely host-side
 * work (globalState + the keychain), so this webview runs no `WorkerDeckClient` and
 * cannot reach a gateway even if it tried.
 */
export type GatewaysToHost =
  | { kind: 'wd-ready' }
  | {
      /** Save (id present = edit). The key goes straight to the keychain. */
      kind: 'wd-submit-gateway'
      id?: string
      name: string
      baseUrl: string
      authKey: string
    }
  | { kind: 'wd-remove-gateway'; hostId: string }
  | {
      /** Ask for the edit form — the host answers with `wd-gateway-form`, key
       * prefilled from the keychain (a webview cannot read it itself). */
      kind: 'wd-edit-gateway'
      hostId: string
    }
  | {
      /** The form opened or closed. Mirrored because the host draws this view's
       * chrome: the title, and the context key swapping `+` for a back chevron. */
      kind: 'wd-gateway-form-state'
      open: boolean
    }

/** Host → gateways view. */
export type HostToGateways =
  | { kind: 'wd-gateways'; hosts: WireHost[]; sessionCounts: Record<string, number> }
  | {
      /** Open the add/edit form, or (`gateway: undefined`, `open: false`) go
       * back to the list. Prefilled for an edit. */
      kind: 'wd-gateway-form'
      open: boolean
      gateway?: { id: string; name: string; baseUrl: string; authKey: string }
    }
  | { kind: 'wd-form-result'; ok: boolean; error?: string }

/** Section view (Session Info / Context / Usage / MCP) → host. */
export type SectionToHost = TransportToHost | { kind: 'wd-ready' }

/** Host → section view. State + vitals ride the same shapes the sidebar gets. */
export type HostToSection =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | { kind: 'wd-vitals'; vitals?: SessionVitals }

export type WebviewToHost = PanelToHost | SidebarToHost | SectionToHost | GatewaysToHost
export type HostToWebview = HostToPanel | HostToSidebar | HostToSection | HostToGateways
