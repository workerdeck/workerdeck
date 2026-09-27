import type { ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { SessionInfo } from '@workerdeck/protocol'
import { McpPanel, McpPanelActions, useMcpPanel } from '@workerdeck/ui'
import { formatCost } from '@workerdeck/ui/format'

function formatSessionCost(info: SessionInfo): string | undefined {
  const usd = info.costUsd ?? info.totalCostUsd
  return usd === undefined ? undefined : formatCost(usd)
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-body-sm">
      <span className="shrink-0 text-fg-4">{label}</span>
      <span className="min-w-0 truncate text-right text-fg-2">{value}</span>
    </div>
  )
}

export function InfoSection({ info }: { info: SessionInfo }) {
  return (
    <div>
      <Row label="engine" value={info.engine ?? 'claude'} />
      <Row label="model" value={info.model} />
      <Row label="profile" value={info.profile} />
      <Row label="cwd" value={<span className="font-mono text-[11px]">{info.cwd}</span>} />
      <Row label="permission mode" value={info.permissionMode} />
      <Row label="credentials" value={info.apiKeySource} />
      <Row label="turns" value={info.numTurns} />
      <Row label="cost" value={formatSessionCost(info)} />
      <Row label="session id" value={<span className="font-mono text-[11px]">{info.id}</span>} />
    </div>
  )
}

type McpSectionProps = { client: WorkerDeckClient | undefined; sessionId: string; canManageServers: boolean }

export function McpSection({ client, sessionId, canManageServers }: McpSectionProps) {
  const mcp = useMcpPanel(client, sessionId)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-body-sm text-fg-2">{mcp.title}</span>
        <McpPanelActions model={mcp} />
      </div>
      <McpPanel model={mcp} canManageServers={canManageServers} />
    </div>
  )
}
