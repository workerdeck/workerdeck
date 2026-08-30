import { FolderOpen, Layers, Plug, SearchX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, SessionRow } from '@workerdeck/protocol'
import type { SidebarState } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { ProjectIcon } from '@workerdeck/ui'
import { Empty, Key } from '../ui/Empty.tsx'
import { SessionCard } from './SessionCard.tsx'
import { SubsetLine } from './SubsetLine.tsx'
import { ViewConfigPanel } from './ViewConfigPanel.tsx'
import {
  DEFAULT_VIEW_CONFIG,
  adaptersOf,
  buildRows,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  projectsOf,
  scopeActive,
  subsetSummary,
  type ViewConfig,
} from '../../src/view-config.ts'

type Persisted = { config?: ViewConfig }

/** The resolved bytes for a session's project icon. Shared by the row and its group
 * header so the two cannot draw different pictures for one project. */
const iconSrcOf = (info: SessionInfo | undefined, icons: Record<string, string>): string | undefined => {
  const icon = info?.project?.icon
  return icon?.type === 'image' ? icons[icon.hash] : undefined
}

/**
 * The Sessions view: every gateway's sessions in one list, grouped and sorted, and
 * nothing else — no screens, no forms, no navigation.
 *
 * Two things it does not own: the **filter bar**, revealed by a native view-title
 * toggle whose boolean the host holds, and the **`+`** in that same title bar, which
 * is the only way to start a session — this body never grows a second button for it.
 *
 * It does own the view config (search, facets, group, sort), which it persists and
 * mirrors to the host so the unread item counts the rows the list is showing.
 */
export function SidebarApp({ bridge }: { bridge: Bridge }) {
  const [state, setState] = useState<SidebarState | undefined>(undefined)
  // Merged, never replaced: the host sends each hash once as it resolves.
  const [projectIcons, setProjectIcons] = useState<Record<string, string>>({})
  const [filterOpen, setFilterOpen] = useState(false)
  const persisted = bridge.getState<Persisted>()
  // Spread over the defaults: a config persisted by an older build is missing newer fields.
  const [config, setConfig] = useState<ViewConfig>({
    ...DEFAULT_VIEW_CONFIG,
    ...persisted?.config,
  })

  // The view config outlives a reload — VS Code tears webviews down freely.
  useEffect(() => {
    bridge.setState<Persisted>({ config })
  }, [bridge, config])

  // …and the host mirrors it, so the unread item counts the rows this list is showing.
  // One-way: the webview owns the config, the host only reads it.
  useEffect(() => {
    bridge.post({ kind: 'wd-view-config', config })
  }, [bridge, config])

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        switch (msg.kind) {
          case 'wd-sidebar-state':
            setState(msg.state)
            return
          case 'wd-project-icons':
            setProjectIcons((held) => ({ ...held, ...msg.icons }))
            return
          case 'wd-filter-open':
            setFilterOpen(msg.open)
            return
        }
      }),
    [bridge],
  )

  const hosts = state?.hosts ?? []
  const scope = state?.scope
  const rows = useMemo(() => buildRows(state), [state])
  const adapters = useMemo(() => adaptersOf(rows), [rows])
  const projects = useMemo(() => projectsOf(rows), [rows])
  const filtered = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const groups = useMemo(() => groupRows(filtered, config), [filtered, config])
  const connected = hosts.filter((h) => h.probe === 'connected')
  const scoping = scopeActive(config, scope)
  const subset = subsetSummary(config, scope, filtered.length, rows.length)
  /**
   * `state.selected` if it names *this* row. Matched on **host and session**, never on
   * session alone: ids come from the engines, so two gateways can hand out the same
   * one, and an id-only test lights the wrong card in exactly the multi-gateway case
   * this window exists to make legible.
   */
  const selectedIs = (row: SessionRow) =>
    state?.selected?.hostId === row.hostId && state.selected.sessionId === row.info.id ? state.selected : undefined

  return (
    <div className="flex h-screen flex-col text-body-sm">
      {/* Behind the title bar's filter toggle, and hidden by default — which is why the
          subset line below is unconditional. */}
      {filterOpen ? (
        <ViewConfigPanel config={config} hosts={hosts} adapters={adapters} projects={projects} scope={scope} onChange={setConfig} />
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
          // Three different nothings: the filter matched none, the scope holds none, or there are none.
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
                  projectIcons={projectIcons}
                  selected={selectedIs(row) !== undefined}
                  /* Only THIS card's frame: `selected` is one object for the whole list, so
                     reading its `subagentToolUseId` unguarded turns every card grey. */
                  activeSubagentId={selectedIs(row)?.subagentToolUseId}
                  onSelect={() =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
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
                  onRevealStep={(revealToolUseId) =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                      revealToolUseId,
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
