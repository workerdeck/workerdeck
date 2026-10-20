import type { GatewayRelayMeta, PermissionMode, ScopeRoot, SessionInfo, WorkspaceScope } from '@workerdeck/protocol'
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
  relay?: GatewayRelayMeta
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
  accountExpiresAt?: string
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
export type SurfaceState = { hostId: string; sessionId: string; cwd?: string; agentId?: string }

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
  | { kind: 'wd-superseded'; sessionId: string; successor: string }
  | { kind: 'wd-go-to-current'; sessionId: string }
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
        // Set when the surface shows an agent rather than one conversation; it rides window reloads.
        agentId?: string
        // The conversation this surface just followed its agent away from.
        carryFrom?: string
      }
      // The bottom panel's info state: the session it last showed now lives in an editor tab.
      held?: { title: string }
    }
  | {
      kind: 'wd-set-model'
      model?: string
    }
  | { kind: 'wd-set-effort'; effort?: string }
  | { kind: 'wd-set-permission-mode'; mode: PermissionMode }
  | { kind: 'wd-insert-composer-text'; text: string }
  // The composer's `#` rows, keyed by session id on the surface's own gateway.
  | { kind: 'wd-peer-avatars'; avatars: Record<string, AgentAvatarImage> }
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
      shellId?: string
      target?: SurfaceTarget
    }
  | {
      kind: 'wd-kill-shell'
      hostId: string
      sessionId: string
      shellId: string
    }
  | {
      kind: 'wd-stop-task'
      hostId: string
      sessionId: string
      toolUseId: string
    }
  | {
      kind: 'wd-shell-agent-write'
      hostId: string
      sessionId: string
      shellId: string
      enabled: boolean
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
  | { kind: 'wd-rename-agent'; hostId: string; sessionId: string; name: string }
  | {
      kind: 'wd-team-move'
      hostId: string
      sessionId: string
      // The lead's session, or null to leave the team. `leadHostId` is set when the lead lives on another gateway.
      leadSessionId: string | null
      leadHostId?: string
      order?: number
      siblings?: { hostId?: string; sessionId: string; order: number }[]
    }
  | {
      kind: 'wd-reveal-gateways'
      add?: boolean
    }
  | {
      kind: 'wd-view-config'
      config: ViewConfig
    }
  | {
      kind: 'wd-new-session'
      hostId: string
      cwd?: string
    }

// The same shape as `@workerdeck/ui`'s `AgentAvatarImage`, restated so the extension host never imports the ui package.
export type AgentAvatarImage = { still: string; busy?: { src: string; durations: number[] } }

export type HostToSidebar =
  | TransportToWebview
  | { kind: 'wd-sidebar-state'; state: SidebarState }
  | {
      kind: 'wd-search-open'
      open: boolean
    }
  | { kind: 'wd-filters-toggle' }
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
  | { kind: 'wd-agent-avatars'; avatars: Record<string, AgentAvatarImage> }
  | { kind: 'wd-avatar-picker'; hostId: string; sessionId: string }

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

export type FileEntryKind = 'file' | 'folder'

export type WireFileEntry = { name: string; uri: string; kind: FileEntryKind; lang?: string; link?: boolean }

export type WireFilesRoot = { uri: string; name: string; label: string; local: boolean; parentName: string }

export type WireDecoration = { color?: string; badge?: string; tooltip?: string; faded?: boolean }

export type FileOpenMode = 'preview' | 'pinned' | 'side'

export type FilesCommand = 'newFile' | 'newFolder' | 'collapseAll' | 'rename' | 'delete' | 'copy' | 'cut' | 'paste'

export type UploadedFile = { name: string; b64: string }

export type FilesToHost =
  | { kind: 'wd-ready' }
  | { kind: 'wd-files-list'; uri: string }
  | { kind: 'wd-files-open'; uris: string[]; mode: FileOpenMode }
  | { kind: 'wd-files-create'; parent: string; name: string; entry: FileEntryKind }
  | { kind: 'wd-files-rename'; uri: string; name: string }
  | { kind: 'wd-files-delete'; uris: string[] }
  | { kind: 'wd-files-move'; uris: string[]; target: string; copy: boolean }
  | { kind: 'wd-files-clipboard'; uris: string[]; cut: boolean }
  | { kind: 'wd-files-paste'; target: string }
  | { kind: 'wd-files-upload'; target: string; files: UploadedFile[] }
  | { kind: 'wd-files-drop-uris'; target: string; uris: string[] }
  | { kind: 'wd-files-selection'; uris: string[] }
  | { kind: 'wd-files-editing'; editing: boolean }
  | { kind: 'wd-files-focus'; focused: boolean }
  | { kind: 'wd-files-copy-path'; uris: string[]; relative: boolean }
  | { kind: 'wd-files-reveal-os'; uri: string }

export type HostToFiles =
  | { kind: 'wd-files-root'; root?: WireFilesRoot; message?: string }
  | { kind: 'wd-files-dir'; uri: string; entries?: WireFileEntry[]; error?: string }
  | { kind: 'wd-files-refresh' }
  | {
      kind: 'wd-files-theme'
      css: string
      fileIcons: boolean
      folderIcons: boolean
      hideArrows: boolean
      modern: boolean
      compact: boolean
    }
  | { kind: 'wd-files-decorations'; decorations: Record<string, WireDecoration> }
  | { kind: 'wd-files-command'; command: FilesCommand; uri?: string }
  | { kind: 'wd-files-reveal'; uri: string; ancestors: string[]; focus: boolean }
  | { kind: 'wd-files-cut'; uris: string[] }
  | { kind: 'wd-files-moved'; moves: { from: string; to: string }[] }

export type WebviewToHost = PanelToHost | SidebarToHost | SectionToHost | GatewaysToHost | ProfilesToHost | FilesToHost
export type HostToWebview = HostToPanel | HostToSidebar | HostToSection | HostToGateways | HostToProfiles | HostToFiles
