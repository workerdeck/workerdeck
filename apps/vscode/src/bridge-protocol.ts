import type { PermissionMode, ScopeRoot, SessionInfo, WorkspaceScope } from '@workerdeck/protocol'
import type { SubagentDisplay, ViewConfig } from './view-config.ts'
import type { SessionSurfacePanel, SessionVitals } from '@workerdeck/ui'

export type WireHost = {
  id: string
  name: string
  baseUrl: string
  rawUrl: string
  local: boolean
  probe: 'connected' | 'unauthorized' | 'unreachable' | 'pending'
  cwdSuggestion?: string
  managed?: boolean
}

export type WireProfile = {
  hostId: string
  hostName: string
  name: string
  engine: string
  managed: boolean
  canManage: boolean
  configDir?: string
  description?: string
  available?: boolean
  unavailableReason?: string
  defaultModel?: string
  defaultPermissionMode?: string
}

export type { ScopeRoot, WorkspaceScope }

export type SurfaceTarget = 'editor' | 'editor-beside'

export type SidebarState = {
  hosts: WireHost[]
  sessions: Record<string, SessionInfo[]>
  selected?: { hostId: string; sessionId: string; subagentToolUseId?: string; shellId?: string }
  scope?: WorkspaceScope
  unseen?: Record<string, number>
  // `host:session` keys of the sessions an editor tab holds.
  open?: Record<string, 'editor'>
}

// What a session tab persists across a window reload (`bridge.setState`), read back by the panel serializer.
export type SurfaceState = { hostId: string; sessionId: string; cwd?: string }

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

export type PanelToHost =
  | TransportToHost
  | { kind: 'wd-ready' }
  | { kind: 'wd-focus' }
  | { kind: 'wd-focus-held' }
  | { kind: 'wd-open-path'; path: string; line?: number }
  | { kind: 'wd-open-url'; url: string }
  | {
      kind: 'wd-vitals'
      vitals: SessionVitals
    }
  | {
      kind: 'wd-open-panel'
      panel: SessionSurfacePanel
    }
  | {
      kind: 'wd-subagent-open'
      toolUseId?: string
    }
  | {
      kind: 'wd-shell-open'
      shellId?: string
    }

export type HostToPanel =
  | TransportToWebview
  | {
      kind: 'wd-show-session'
      session?: {
        baseUrl: string
        hostId: string
        sessionId: string
        hostName: string
        cwd?: string
        unseen?: { itemCount: number; since: number }
      }
      // The bottom panel's info state: the session it last showed now lives in an editor tab.
      held?: { title: string }
    }
  | {
      kind: 'wd-set-model'
      model?: string
    }
  | { kind: 'wd-set-permission-mode'; mode: PermissionMode }
  | { kind: 'wd-insert-composer-text'; text: string }
  | {
      kind: 'wd-focus-composer'
    }
  | {
      kind: 'wd-open-subagent'
      toolUseId: string
      nonce: number
    }
  | {
      kind: 'wd-reveal-tool-use'
      toolUseId: string
      nonce: number
    }
  | {
      kind: 'wd-open-shell'
      shellId: string
      nonce: number
    }

export type SidebarToHost =
  | TransportToHost
  | { kind: 'wd-ready' }
  | {
      kind: 'wd-select-session'
      hostId: string
      sessionId: string
      subagentToolUseId?: string
      revealToolUseId?: string
      target?: SurfaceTarget
    }
  | {
      kind: 'wd-stop-session'
      hostId: string
      sessionId: string
    }
  | { kind: 'wd-delete-session'; hostId: string; sessionId: string }
  | {
      kind: 'wd-session-menu'
      hostId: string
      sessionId: string
    }
  | {
      kind: 'wd-rename-session'
      hostId: string
      sessionId: string
      title: string
    }
  | {
      kind: 'wd-reveal-gateways'
      add?: boolean
    }
  | {
      kind: 'wd-view-config'
      config: ViewConfig
    }

export type HostToSidebar =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | {
      kind: 'wd-filter-open'
      open: boolean
    }
  | {
      kind: 'wd-subagents'
      subagents: SubagentDisplay
    }
  | {
      kind: 'wd-vitals'
      vitals?: SessionVitals
    }
  | {
      kind: 'wd-project-icons'
      icons: Record<string, string>
    }

export type GatewaysToHost =
  | { kind: 'wd-ready' }
  | { kind: 'wd-remove-gateway'; hostId: string }
  | {
      kind: 'wd-edit-gateway'
      hostId: string
    }

// Adding and editing a gateway is a native multi-step input on the host side (`new-gateway.ts`),
// so nothing about a form crosses this bridge.
export type HostToGateways = { kind: 'wd-gateways'; hosts: WireHost[]; sessionCounts: Record<string, number> }

export type ProfilesToHost =
  | { kind: 'wd-ready' }
  | { kind: 'wd-edit-profile'; hostId: string; name: string }
  | { kind: 'wd-remove-profile'; hostId: string; name: string }
  | { kind: 'wd-add-profile'; hostId: string }

// Like the gateways view, every mutation is a native flow on the host side: this bridge carries a list and three verbs.
export type HostToProfiles = { kind: 'wd-profiles'; profiles: WireProfile[]; gateways: number }

export type SectionToHost = TransportToHost | { kind: 'wd-ready' }

export type HostToSection =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | { kind: 'wd-vitals'; vitals?: SessionVitals }
  | { kind: 'wd-tasks-show-completed'; showCompleted: boolean }

export type WebviewToHost = PanelToHost | SidebarToHost | SectionToHost | GatewaysToHost | ProfilesToHost
export type HostToWebview = HostToPanel | HostToSidebar | HostToSection | HostToGateways | HostToProfiles
