import { useCallback, useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type {
  McpServerActionRequest,
  McpServerStatusInfo,
  McpServerToolInfo,
} from '@workerdeck/protocol'
import { ChevronLeft, ChevronRight, Power, PowerOff, RotateCw } from 'lucide-react'
import { Badge, type BadgeProps } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogRow } from '../ui/Dialog.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

export interface McpDialogProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Whether this engine can reconnect/enable/disable a server
   * (`EngineCapabilities.mcpServerActions`). False renders the panel read-only:
   * codex reports rich status but exposes no per-server action, and buttons
   * that 501 are worse than buttons that aren't there.
   */
  canManageServers?: boolean
}

/** The engine's status vocabulary is open — anything unrecognised renders
 * neutrally rather than being forced into one of these. */
const STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  connected: 'success',
  failed: 'danger',
  'needs-auth': 'warning',
  pending: 'info',
  disabled: 'neutral',
}

/**
 * The session's MCP servers, at the CLI's own `/mcp` depth: servers → one server
 * → its tools → one tool, with Reconnect / Enable / Disable where they apply.
 *
 * Two things vary by engine rather than being fixed here. **The actions** exist
 * only where the engine has them (`canManageServers`): codex reports rich status
 * but has no per-server reconnect or toggle, so its panel is read-only. And
 * **tool parameters** appear only where the engine reports a schema — codex
 * returns each tool's full JSON Schema, the Agent SDK returns none at all, so
 * the tool view either renders it or says why it can't, rather than leaving a
 * silent gap or claiming the absence is universal.
 */
export function McpDialog({
  client,
  sessionId,
  open,
  onOpenChange,
  canManageServers = true,
}: McpDialogProps) {
  const [servers, setServers] = useState<McpServerStatusInfo[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [busyServer, setBusyServer] = useState<string | undefined>()
  // The drill-down, by name rather than by object — an action replaces the whole
  // list, and a held reference would go stale on the first Reconnect.
  const [selectedServer, setSelectedServer] = useState<string | undefined>()
  const [selectedTool, setSelectedTool] = useState<string | undefined>()

  const load = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    setError(undefined)
    try {
      setServers(await client.listMcpServers(sessionId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read MCP status')
    } finally {
      setLoading(false)
    }
  }, [client, sessionId])

  useEffect(() => {
    if (!open) return
    setSelectedServer(undefined)
    setSelectedTool(undefined)
    void load()
  }, [open, load])

  const act = async (name: string, action: McpServerActionRequest['action']) => {
    if (!sessionId) return
    setBusyServer(name)
    setError(undefined)
    try {
      setServers(await client.mcpServerAction(sessionId, name, action))
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${action} ${name}`)
    } finally {
      setBusyServer(undefined)
    }
  }

  const server = servers?.find((s) => s.name === selectedServer)
  const tool = server?.tools?.find((t) => t.name === selectedTool)
  const title = tool?.name ?? server?.name ?? 'MCP servers'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title={title}
          description={
            tool ? `${server?.name} tool` : server ? server.serverInfo?.name : undefined
          }
          actions={
            selectedServer ? (
              <Button
                variant='ghost'
                size='xs'
                onClick={() => (selectedTool ? setSelectedTool(undefined) : setSelectedServer(undefined))}>
                <ChevronLeft className='size-3.5' />
                Back
              </Button>
            ) : (
              <Button variant='ghost' size='xs' onClick={() => void load()} disabled={loading}>
                {loading ? <Spinner className='size-3 text-current' /> : <RotateCw className='size-3' />}
                Refresh
              </Button>
            )
          }
        />
        <DialogBody>
          {error ? (
            <div className='mb-3 rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>
              {error}
            </div>
          ) : null}
          {tool ? (
            <ToolView tool={tool} />
          ) : server ? (
            <ServerView
              server={server}
              busy={busyServer === server.name}
              canManage={canManageServers}
              onAct={(action) => void act(server.name, action)}
              onSelectTool={setSelectedTool}
            />
          ) : (
            <ServerList
              servers={servers}
              loading={loading}
              onSelect={setSelectedServer}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ServerList({
  servers,
  loading,
  onSelect,
}: {
  servers: McpServerStatusInfo[] | undefined
  loading: boolean
  onSelect: (name: string) => void
}) {
  if (loading && !servers) {
    return (
      <div className='py-6 text-center'>
        <Spinner className='size-4 text-fg-4' />
      </div>
    )
  }
  if (!servers?.length) {
    return (
      <p className='py-6 text-center text-body-sm text-fg-4'>
        No MCP servers configured for this session.
      </p>
    )
  }
  // Grouped by where they were configured, like the CLI's own screen.
  const scopes = [...new Set(servers.map((s) => s.scope ?? 'other'))]
  return (
    <div className='flex flex-col gap-4'>
      {scopes.map((scope) => (
        <div key={scope}>
          <h3 className='text-label font-medium text-fg-3 capitalize'>{scope}</h3>
          <ul className='mt-1 flex flex-col'>
            {servers
              .filter((s) => (s.scope ?? 'other') === scope)
              .map((s) => (
                <li key={s.name}>
                  <button
                    type='button'
                    onClick={() => onSelect(s.name)}
                    className='flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover'>
                    <span className='min-w-0 flex-1 truncate text-body-sm text-fg-1'>{s.name}</span>
                    {s.tools?.length ? (
                      <span className='shrink-0 text-label text-fg-4'>{s.tools.length} tools</span>
                    ) : null}
                    <Badge variant={STATUS_VARIANT[s.status] ?? 'neutral'} dot className='shrink-0'>
                      {s.status}
                    </Badge>
                    <ChevronRight className='size-3.5 shrink-0 text-fg-4' />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function ServerView({
  server,
  busy,
  canManage,
  onAct,
  onSelectTool,
}: {
  server: McpServerStatusInfo
  busy: boolean
  canManage: boolean
  onAct: (action: McpServerActionRequest['action']) => void
  onSelectTool: (name: string) => void
}) {
  const disabled = server.status === 'disabled'
  return (
    <div className='flex flex-col gap-4'>
      <div>
        <DialogRow label='Status'>
          <Badge variant={STATUS_VARIANT[server.status] ?? 'neutral'} dot>
            {server.status}
          </Badge>
        </DialogRow>
        {server.transport ? <DialogRow label='Transport'>{server.transport}</DialogRow> : null}
        {server.scope ? <DialogRow label='Scope'>{server.scope}</DialogRow> : null}
        {server.serverInfo ? (
          <DialogRow label='Server'>
            {server.serverInfo.name} {server.serverInfo.version}
          </DialogRow>
        ) : null}
        {server.command ? (
          <DialogRow label='Command' mono>
            {[server.command, ...(server.args ?? [])].join(' ')}
          </DialogRow>
        ) : null}
        {server.url ? (
          <DialogRow label='URL' mono>
            {server.url}
          </DialogRow>
        ) : null}
      </div>

      {server.error ? (
        <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm break-words text-danger'>
          {server.error}
        </div>
      ) : null}

      {/* Absent, not disabled, when the engine has no per-server action: a
          greyed-out Reconnect invites the question "why can't I?" on every
          visit, where nothing at all reads as "this engine works differently". */}
      {canManage ? (
        <div className='flex gap-2'>
          <Button variant='outline' size='sm' disabled={busy} onClick={() => onAct('reconnect')}>
            {busy ? <Spinner className='size-3 text-current' /> : <RotateCw className='size-3' />}
            Reconnect
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={() => onAct(disabled ? 'enable' : 'disable')}>
            {disabled ? <Power className='size-3' /> : <PowerOff className='size-3' />}
            {disabled ? 'Enable' : 'Disable'}
          </Button>
        </div>
      ) : null}

      <div>
        <h3 className='text-label font-medium text-fg-3'>Tools</h3>
        {!server.tools?.length ? (
          <p className='py-2 text-body-sm text-fg-4'>
            {server.status === 'connected'
              ? 'This server exposes no tools.'
              : 'Tools are listed once the server connects.'}
          </p>
        ) : (
          <ul className='mt-1 flex flex-col'>
            {server.tools.map((t) => (
              <li key={t.name}>
                <button
                  type='button'
                  onClick={() => onSelectTool(t.name)}
                  className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover'>
                  <span className='min-w-0 flex-1 truncate font-mono text-label text-fg-1'>
                    {t.name}
                  </span>
                  <ChevronRight className='size-3.5 shrink-0 text-fg-4' />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ToolView({ tool }: { tool: McpServerToolInfo }) {
  const annotations = tool.annotations
  return (
    <div className='flex flex-col gap-3'>
      {tool.description ? (
        <p className='text-body-sm whitespace-pre-wrap text-fg-2'>{tool.description}</p>
      ) : (
        <p className='text-body-sm text-fg-4'>This tool carries no description.</p>
      )}
      {annotations ? (
        <div className='flex flex-wrap gap-1.5'>
          {annotations.readOnly ? <Badge variant='success'>read-only</Badge> : null}
          {annotations.destructive ? <Badge variant='danger'>destructive</Badge> : null}
          {annotations.openWorld ? <Badge variant='warning'>open world</Badge> : null}
        </div>
      ) : null}
      {/* Engine-dependent, and said as such: codex returns each tool's full
          JSON Schema, the Agent SDK returns none at all. So this is a real
          section where one exists and an explanation where it doesn't — never a
          silent gap, and never a claim that no engine has them. */}
      {tool.inputSchema !== undefined ? (
        <div>
          <h3 className='text-label font-medium text-fg-3'>Parameters</h3>
          <pre className='mt-1 max-h-64 overflow-auto rounded-md bg-surface px-3 py-2 text-label text-fg-2'>
            {safeSchema(tool.inputSchema)}
          </pre>
        </div>
      ) : (
        <p className={cn('text-label text-fg-4')}>
          Parameters aren’t available: this engine names and describes each tool but reports no
          input schema.
        </p>
      )}
    </div>
  )
}

/** The schema is an opaque JSON document from another process — pretty-print it,
 * and never let an unserializable value take the dialog down with it. */
function safeSchema(schema: unknown): string {
  try {
    return JSON.stringify(schema, null, 2)
  } catch {
    return String(schema)
  }
}
