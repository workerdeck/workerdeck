import { useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import { rateLimitWindows } from '@workerdeck/react'
import { ContextPanel, UsageMeters, type SessionVitals } from '@workerdeck/ui'
import type { SidebarState } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { InfoSection, McpSection } from './content.tsx'

export type SectionKind = 'info' | 'context' | 'usage' | 'mcp'

// The manifest's `when` clauses hide a view with no session or no capability, so the fallbacks here only cover the races in between.
export function SectionApp({ bridge, kind }: { bridge: Bridge; kind: SectionKind }) {
  const [state, setState] = useState<SidebarState | undefined>(undefined)
  const [vitals, setVitals] = useState<SessionVitals | undefined>(undefined)

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        if (msg.kind === 'wd-sidebar-state') {
          setState(msg.state)
        } else if (msg.kind === 'wd-vitals') {
          setVitals(msg.vitals)
        }
      }),
    [bridge],
  )

  const selected = state?.selected
  const info: SessionInfo | undefined = selected ? state?.sessions[selected.hostId]?.find((s) => s.id === selected.sessionId) : undefined
  const host = selected ? state?.hosts.find((h) => h.id === selected.hostId) : undefined

  const client = useMemo(
    () =>
      host
        ? new WorkerDeckClient({
            baseUrl: host.baseUrl,
            fetchImpl: bridge.fetch,
            WebSocketImpl: bridge.WebSocketImpl,
          })
        : undefined,
    [bridge, host?.baseUrl],
  )

  if (!info) {
    return <Empty>Select a session in the WorkerDeck sidebar.</Empty>
  }

  const caps = vitals?.capabilities ?? info.capabilities ?? ENGINE_CAPABILITIES[info.engine ?? 'claude']
  const engine = info.engine ?? 'claude'

  switch (kind) {
    case 'info': {
      return (
        <Pad>
          <InfoSection info={info} />
        </Pad>
      )
    }
    case 'context': {
      if (!caps.contextUsage) {
        return <Empty>{engine} reports no context window.</Empty>
      }
      return (
        <Pad>
          <ContextPanel usage={vitals?.contextUsage} engine={engine} />
        </Pad>
      )
    }
    case 'usage': {
      if (!caps.rateLimits) {
        return <Empty>{engine} reports no plan usage.</Empty>
      }
      const windows = rateLimitWindows({ rateLimits: vitals?.rateLimits })
      return (
        <Pad>
          {windows.length === 0 ? (
            <div className="py-1 text-body-sm text-fg-4">No plan-usage reading yet.</div>
          ) : (
            <UsageMeters windows={windows} className="gap-4" />
          )}
        </Pad>
      )
    }
    case 'mcp': {
      if (!caps.mcpStatus) {
        return <Empty>{engine} exposes no MCP servers.</Empty>
      }
      return (
        <Pad>
          <McpSection client={client} sessionId={info.id} canManageServers={caps.mcpServerActions} />
        </Pad>
      )
    }
  }
}

function Pad({ children }: { children: React.ReactNode }) {
  return <div className="p-2">{children}</div>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-3 text-body-sm text-fg-4">{children}</div>
}
