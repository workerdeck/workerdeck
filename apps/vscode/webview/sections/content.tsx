import { useEffect, useState, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { ContextUsage, McpServerStatusInfo, RateLimitInfo, SessionInfo } from '@workerdeck/protocol'
import { rateLimitWindows, type TranscriptState } from '@workerdeck/react'
import { Badge, Button, Spinner, UsageMeters, cn } from '@workerdeck/ui'
import { RefreshCw } from 'lucide-react'

/**
 * The scoped surfaces for the selected session — what the panel's dialogs used
 * to show, each rehomed into its OWN VS Code view (native headers, collapse,
 * drag-anywhere live in VS Code, not here). Info renders from the pushed REST
 * rollup; Context and Usage render from the vitals the agent panel relays (it
 * owns the one live attach — these views must never attach); MCP fetches over
 * its view's own bridged client, REST only.
 */

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
      <Row label="cost" value={info.totalCostUsd !== undefined ? `$${info.totalCostUsd.toFixed(3)}` : undefined} />
      <Row label="session id" value={<span className="font-mono text-[11px]">{info.id}</span>} />
    </div>
  )
}

export function ContextSection({ usage }: { usage: ContextUsage | undefined }) {
  if (!usage) {
    return <div className="py-1 text-body-sm text-fg-4">No context reading yet.</div>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-body-sm">
        <span className="text-fg-2">
          {formatTokens(usage.totalTokens)} / {formatTokens(usage.maxTokens)}
        </span>
        <span className={cn('font-mono', usage.percentage >= 85 ? 'text-warning' : 'text-fg-3')}>{Math.round(usage.percentage)}%</span>
      </div>
      <Meter percent={usage.percentage} warn={85} />
      <div className="mt-1 flex flex-col">
        {usage.categories.map((c) => (
          <div key={c.name} className="flex items-baseline justify-between py-0.5 text-body-sm">
            <span className="text-fg-3">{c.name}</span>
            <span className="font-mono text-fg-4">{formatTokens(c.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * `UsageMeters` rather than a bar of our own: the pace marker is the whole
 * value of these meters — "17% used" only means something once you know how far
 * into the window you are — and it was invented twice already (iOS's `UsageBar`,
 * the panel's Usage dialog). A third hand-rolled copy here is how the dock came
 * to be the one surface without it.
 */
export function UsageSection({ rateLimits }: { rateLimits: Record<string, RateLimitInfo> | undefined }) {
  // rateLimitWindows reads only `rateLimits` — the cast hands it the one field
  // it consumes without dragging a full transcript state into the sidebar.
  const windows = rateLimitWindows({ rateLimits } as TranscriptState)
  if (windows.length === 0) {
    return <div className="py-1 text-body-sm text-fg-4">No plan-usage reading yet.</div>
  }
  // No `now` prop: this view is mounted for as long as its section is expanded,
  // so it ticks its own minute clock. Passing one would mean this file owning a
  // timer the section has no other use for.
  return <UsageMeters windows={windows} className="gap-4" />
}

export function McpSection({ client, sessionId }: { client: WorkerDeckClient | undefined; sessionId: string }) {
  const [servers, setServers] = useState<McpServerStatusInfo[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busyServer, setBusyServer] = useState<string | undefined>(undefined)

  useEffect(() => {
    setServers(undefined)
    setError(undefined)
    if (!client) {
      return
    }
    let stale = false
    client
      .listMcpServers(sessionId)
      .then((list) => {
        if (!stale) {
          setServers(list)
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      stale = true
    }
  }, [client, sessionId])

  const act = async (name: string, action: 'reconnect' | 'enable' | 'disable') => {
    if (!client) {
      return
    }
    setBusyServer(name)
    try {
      setServers(await client.mcpServerAction(sessionId, name, action))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyServer(undefined)
    }
  }

  if (error) {
    return <div className="py-1 text-body-sm text-danger">{error}</div>
  }
  if (!servers) {
    return (
      <div className="flex items-center gap-2 py-1 text-body-sm text-fg-3">
        <Spinner className="size-3" /> loading…
      </div>
    )
  }
  if (servers.length === 0) {
    return <div className="py-1 text-body-sm text-fg-4">No MCP servers on this session.</div>
  }
  return (
    <div className="flex flex-col gap-1">
      {servers.map((s) => (
        <div key={s.name} className="flex items-center gap-2 py-0.5 text-body-sm">
          <span className="min-w-0 flex-1 truncate text-fg-2">{s.name}</span>
          <Badge variant={s.status === 'connected' ? 'success' : s.status === 'failed' ? 'danger' : 'neutral'}>{s.status}</Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Reconnect ${s.name}`}
            disabled={busyServer === s.name}
            onClick={() => void act(s.name, 'reconnect')}
          >
            {busyServer === s.name ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
          </Button>
        </div>
      ))}
    </div>
  )
}

function Meter({ percent, warn }: { percent: number; warn: number }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-hover">
      <div
        className={cn('h-full rounded-full', clamped >= warn ? 'bg-warning' : 'bg-(--vscode-progressBar-background,var(--info))')}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`
  }
  return String(tokens)
}
