import { Layers, Plug } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionRow } from '@workerdeck/protocol'
import type { SidebarState, SidebarToHost, SurfaceTarget } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { SessionBrowser, SessionFilters, SessionSearch, type SelectModifiers } from '@workerdeck/ui'
import { Empty, Key } from '../ui/Empty.tsx'
import { CardActions } from './CardActions.tsx'
import { SubsetLine } from './SubsetLine.tsx'
import { DEFAULT_VIEW_CONFIG, buildRows, clearFilters, filterRows, subsetSummary, type ViewConfig } from '../../src/view-config.ts'

type Persisted = { config?: ViewConfig }

type RowMessage = Extract<SidebarToHost, { hostId: string; sessionId: string }>

type RowExtra<K extends RowMessage['kind']> = Omit<Extract<RowMessage, { kind: K }>, 'kind' | 'hostId' | 'sessionId'>

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// Cmd (macOS) / Ctrl (elsewhere) opens a tab in the active column, Alt/Option one to the side: the explorer's own modifiers.
function targetOf(modifiers: SelectModifiers): SurfaceTarget | undefined {
  if (IS_MAC ? modifiers.meta : modifiers.ctrl) {
    return 'editor'
  }
  if (modifiers.alt) {
    return 'editor-beside'
  }
  return undefined
}

export function SidebarApp({ bridge }: { bridge: Bridge }) {
  const [state, setState] = useState<SidebarState | undefined>(undefined)
  // Merged, never replaced: the host sends each hash once as it resolves.
  const [projectIcons, setProjectIcons] = useState<Record<string, string>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const persisted = bridge.getState<Persisted>()
  // Spread over the defaults: a config persisted by an older build is missing newer fields.
  const [config, setConfig] = useState<ViewConfig>({
    ...DEFAULT_VIEW_CONFIG,
    ...persisted?.config,
  })

  // The view config outlives a reload - VS Code tears webviews down freely.
  useEffect(() => {
    bridge.setState<Persisted>({ config })
  }, [bridge, config])

  useEffect(() => {
    bridge.post({ kind: 'wd-view-config', config })
  }, [bridge, config])

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        switch (msg.kind) {
          case 'wd-sidebar-state': {
            setState(msg.state)
            return
          }
          case 'wd-project-icons': {
            setProjectIcons((held) => ({ ...held, ...msg.icons }))
            return
          }
          case 'wd-search-open': {
            setSearchOpen(msg.open)
            if (!msg.open) {
              setConfig((held) => (held.search ? { ...held, search: '' } : held))
            }
            return
          }
          case 'wd-filters-toggle': {
            setFiltersOpen((open) => !open)
            return
          }
          case 'wd-subagents': {
            setConfig((held) => (held.subagents === msg.subagents ? held : { ...held, subagents: msg.subagents }))
            return
          }
        }
      }),
    [bridge],
  )

  const hosts = state?.hosts ?? []
  const scope = state?.scope
  const rows = useMemo(() => buildRows(state), [state])
  const gateways = useMemo(() => hosts.map((host) => ({ id: host.id, name: host.name })), [hosts])
  const filtered = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const connected = hosts.filter((h) => h.probe === 'connected')
  const subset = subsetSummary(config, scope, filtered.length, rows.length)
  const selected = state?.selected
  const isActive = (row: SessionRow) => selected?.hostId === row.hostId && selected.sessionId === row.info.id
  const postRow = <K extends RowMessage['kind']>(kind: K, row: SessionRow, extra: RowExtra<K>) =>
    bridge.post({ kind, hostId: row.hostId, sessionId: row.info.id, ...extra } as RowMessage)

  return (
    <div className="flex h-screen flex-col text-body-sm">
      {searchOpen ? (
        <SessionSearch
          value={config.search}
          onChange={(search) => setConfig({ ...config, search })}
          autoFocus
          className="shrink-0 border-b border-border px-2 py-1.5"
          inputClassName="h-6 text-body-sm"
        />
      ) : null}
      {filtersOpen ? (
        <>
          <div aria-hidden className="fixed inset-0 z-40" onMouseDown={() => setFiltersOpen(false)} />
          <div
            role="dialog"
            aria-label="Session filters"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setFiltersOpen(false)
              }
            }}
            className="fixed top-1 right-1 z-50 max-h-[calc(100vh-0.5rem)] w-[min(20rem,calc(100vw-0.5rem))] overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-(--shadow-lg)"
          >
            <SessionFilters config={config} onConfigChange={setConfig} rows={rows} scope={scope} gateways={gateways} />
          </div>
        </>
      ) : null}

      {subset ? <SubsetLine subset={subset} onClear={() => setConfig(clearFilters(config))} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {hosts.length === 0 ? (
          <Empty
            icon={<Plug />}
            title="No gateways yet"
            description={
              <>
                Start one with <code className="font-mono">npx workerdeck</code>, then add it in the Gateways view below.
              </>
            }
          />
        ) : connected.length === 0 ? (
          <Unreachable hosts={hosts} />
        ) : (
          <SessionBrowser
            rows={rows}
            config={config}
            onConfigChange={setConfig}
            scope={scope}
            showControls={false}
            showSearch={false}
            showSubset={false}
            gatewayCount={hosts.length}
            projectIcons={projectIcons}
            isActive={isActive}
            activeSubagentId={selected?.subagentToolUseId}
            activeShellId={selected?.shellId}
            rowActions={(row) => (
              <CardActions
                inEditor={state?.open?.[`${row.hostId}:${row.info.id}`] === 'editor'}
                onMenu={() => postRow('wd-session-menu', row, {})}
              />
            )}
            onSelect={(row, modifiers) => postRow('wd-select-session', row, { target: targetOf(modifiers) })}
            onSelectSubagent={(row, subagentToolUseId) => postRow('wd-select-session', row, { subagentToolUseId })}
            onSelectTask={(row, task) => postRow('wd-select-session', row, { revealToolUseId: task.toolUseId })}
            onStopTask={(row, toolUseId) => postRow('wd-stop-task', row, { toolUseId })}
            onSelectShell={(row, shellId) => postRow('wd-select-session', row, { shellId })}
            onKillShell={(row, shellId) => postRow('wd-kill-shell', row, { shellId })}
            onShellAgentWrite={(row, shellId, enabled) => postRow('wd-shell-agent-write', row, { shellId, enabled })}
            onRename={(row, title) => postRow('wd-rename-session', row, { title })}
            emptyState={
              <Empty
                icon={<Layers />}
                title="No sessions yet"
                description={
                  <>
                    Start one with <Key>+</Key> above.
                  </>
                }
              />
            }
          />
        )}
      </div>
    </div>
  )
}

function Unreachable({ hosts }: { hosts: SidebarState['hosts'] }) {
  const pending = hosts.some((h) => h.probe === 'pending')
  const unauthorized = hosts.some((h) => h.probe === 'unauthorized')
  return (
    <Empty
      icon={<Plug />}
      title={pending ? 'Connecting…' : unauthorized ? 'Unauthorized' : 'No gateway reachable'}
      description={
        unauthorized
          ? 'Check the gateway’s auth key in the Gateways view.'
          : pending
            ? 'Reaching the configured gateways.'
            : 'Is `npx workerdeck` still running?'
      }
    />
  )
}
