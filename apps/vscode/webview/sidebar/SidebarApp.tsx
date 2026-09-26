import { FolderOpen, Layers, Plug, SearchX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, SessionRow } from '@workerdeck/protocol'
import type { SidebarState, SurfaceTarget } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { ProjectIcon, SessionFilters, SessionSearch, type SelectModifiers } from '@workerdeck/ui'
import { Empty, Key } from '../ui/Empty.tsx'
import { SessionCard } from './SessionCard.tsx'
import { SubsetLine } from './SubsetLine.tsx'
import {
  DEFAULT_VIEW_CONFIG,
  buildRows,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  scopeActive,
  subsetSummary,
  type ViewConfig,
} from '../../src/view-config.ts'

type Persisted = { config?: ViewConfig }

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

function iconSrcOf(info: SessionInfo | undefined, icons: Record<string, string>): string | undefined {
  const icon = info?.project?.icon
  return icon?.type === 'image' ? icons[icon.hash] : undefined
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
  const groups = useMemo(() => groupRows(filtered, config), [filtered, config])
  const connected = hosts.filter((h) => h.probe === 'connected')
  const scoping = scopeActive(config, scope)
  const subset = subsetSummary(config, scope, filtered.length, rows.length)
  const selectedIs = (row: SessionRow) =>
    state?.selected?.hostId === row.hostId && state.selected.sessionId === row.info.id ? state.selected : undefined

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

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
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
          <Empty
            icon={<Plug />}
            title={
              hosts.some((h) => h.probe === 'pending')
                ? 'Connecting…'
                : hosts.some((h) => h.probe === 'unauthorized')
                  ? 'Unauthorized'
                  : 'No gateway reachable'
            }
            description={
              hosts.some((h) => h.probe === 'unauthorized')
                ? 'Check the gateway’s auth key in the Gateways view.'
                : hosts.some((h) => h.probe === 'pending')
                  ? 'Reaching the configured gateways.'
                  : 'Is `npx workerdeck` still running?'
            }
          />
        ) : groups.length === 0 ? (
          subset ? (
            scoping && !hasFacetFilter(config) ? (
              <Empty
                icon={<FolderOpen />}
                title="Nothing in this folder"
                description={`No session is running in ${scope?.label ?? 'this project'}.`}
                action="Show all folders"
                onAction={() => setConfig({ ...config, scoped: false })}
              />
            ) : (
              <Empty
                icon={<SearchX />}
                title="No matches"
                description="No session matches the current search and filters."
                action="Clear filters"
                onAction={() => setConfig(clearFilters(config))}
              />
            )
          ) : (
            <Empty
              icon={<Layers />}
              title="No sessions yet"
              description={
                <>
                  Start one with <Key>+</Key> above.
                </>
              }
            />
          )
        ) : (
          groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              {group.label ? (
                <div className="flex items-center gap-1.5 px-1.5 pb-0.5 pt-1.5 text-label font-semibold uppercase tracking-wide text-fg-4">
                  {/* Every row in the group shares the mark by construction (a group IS one
                      project root), so the first row is a fair source. */}
                  {config.groupBy === 'project' ? (
                    <ProjectIcon
                      icon={group.rows[0]?.info.project?.icon}
                      src={iconSrcOf(group.rows[0]?.info, projectIcons)}
                      name={group.label}
                    />
                  ) : null}
                  {group.label}
                </div>
              ) : null}
              {group.rows.map((row) => (
                <SessionCard
                  key={row.info.id}
                  row={row}
                  showProject={config.groupBy !== 'project'}
                  showGateway={config.groupBy !== 'gateway' && hosts.length > 1}
                  subagents={config.subagents}
                  shells={config.shells}
                  tasks={config.tasks}
                  projectIcons={projectIcons}
                  selected={selectedIs(row) !== undefined}
                  inEditor={state?.open?.[`${row.hostId}:${row.info.id}`] === 'editor'}
                  /* Only THIS card's frame: `selected` is one object for the whole list, so
                     reading its `subagentToolUseId` unguarded turns every card grey. */
                  activeSubagentId={selectedIs(row)?.subagentToolUseId}
                  activeShellId={selectedIs(row)?.shellId}
                  onSelect={(modifiers) =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      target: targetOf(modifiers),
                    })
                  }
                  onSelectSubagent={(subagentToolUseId) =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      subagentToolUseId,
                    })
                  }
                  onSelectTask={(task) =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      revealToolUseId: task.toolUseId,
                    })
                  }
                  onStopTask={(toolUseId) =>
                    bridge.post({
                      kind: 'wd-stop-task',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      toolUseId,
                    })
                  }
                  onSelectShell={(shellId) =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      shellId,
                    })
                  }
                  onKillShell={(shellId) =>
                    bridge.post({
                      kind: 'wd-kill-shell',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      shellId,
                    })
                  }
                  onShellAgentWrite={(shellId, enabled) =>
                    bridge.post({
                      kind: 'wd-shell-agent-write',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      shellId,
                      enabled,
                    })
                  }
                  onRename={(title) =>
                    bridge.post({
                      kind: 'wd-rename-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      title,
                    })
                  }
                  onMenu={() =>
                    bridge.post({
                      kind: 'wd-session-menu',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                    })
                  }
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
