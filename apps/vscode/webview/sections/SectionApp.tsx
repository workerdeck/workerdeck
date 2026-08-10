import { useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { ENGINE_CAPABILITIES, type SessionInfo } from '@workerdeck/protocol'
import type { SessionVitals } from '@workerdeck/ui'
import type { SidebarState } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { ContextSection, InfoSection, McpSection, UsageSection } from './content.tsx'

export type SectionKind = 'info' | 'context' | 'usage' | 'mcp'

/**
 * One section view. The manifest's `when` clauses keep a view hidden when no
 * session is selected or the engine lacks the capability, so the fallbacks
 * here only cover the races in between.
 */
export function SectionApp({ bridge, kind }: { bridge: Bridge; kind: SectionKind }) {
  const [state, setState] = useState<SidebarState | undefined>(undefined)
  const [vitals, setVitals] = useState<SessionVitals | undefined>(undefined)

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        if (msg.kind === 'wd-sidebar-state') setState(msg.state)
        else if (msg.kind === 'wd-vitals') setVitals(msg.vitals)
      }),
    [bridge],
  )

  const selected = state?.selected
  const info: SessionInfo | undefined = selected
    ? state?.sessions[selected.hostId]?.find((s) => s.id === selected.sessionId)
    : undefined
  const host = selected ? state?.hosts.find((h) => h.id === selected.hostId) : undefined

  // MCP's REST client for the selected session's gateway — never attaches.
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

  // Every view is always contributed now, so "nothing to show" is a state each
  // one renders rather than a reason to vanish — the sidebar keeps its shape.
  if (!info) {
    return <Empty>Select a session in the WorkerDeck sidebar.</Empty>
  }

  // Live capabilities first, the REST rollup next, the engine's record last —
  // the panel's own gating order, and the same one the view header uses.
  const caps =
    vitals?.capabilities ?? info.capabilities ?? ENGINE_CAPABILITIES[info.engine ?? 'claude']
  const engine = info.engine ?? 'claude'

  switch (kind) {
    case 'info':
      return (
        <Pad>
          <InfoSection info={info} />
        </Pad>
      )
    case 'context':
      if (!caps.contextUsage) return <Empty>{engine} reports no context window.</Empty>
      return (
        <Pad>
          <ContextSection usage={vitals?.contextUsage} />
        </Pad>
      )
    case 'usage':
      if (!caps.rateLimits) return <Empty>{engine} reports no plan usage.</Empty>
      return (
        <Pad>
          <UsageSection rateLimits={vitals?.rateLimits} />
        </Pad>
      )
    case 'mcp':
      if (!caps.mcpStatus) return <Empty>{engine} exposes no MCP servers.</Empty>
      return (
        <Pad>
          <McpSection client={client} sessionId={info.id} />
        </Pad>
      )
  }
}

function Pad({ children }: { children: React.ReactNode }) {
  return <div className='p-2'>{children}</div>
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className='p-3 text-body-sm text-fg-4'>{children}</div>
}
