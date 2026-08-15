import { FolderOpen, Layers, Plug, SearchX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SidebarState } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
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
  scopeActive,
  subsetSummary,
  type ViewConfig,
} from '../../src/view-config.ts'

type Persisted = { config?: ViewConfig }

/**
 * The Sessions view: every gateway's sessions in one list, grouped and sorted,
 * and nothing else. No screens, no forms, no navigation — creating a session is
 * a native QuickPick and gateways are their own view, so there is nowhere in
 * here to get lost.
 *
 * Two things it does not own. The **filter bar** is revealed by a native
 * view-title toggle, because that is where a toggle whose icon has to change
 * state can actually live; the host holds that boolean and pushes it down. And
 * the **`+`** in that same title bar is the only way to start a session — this
 * body never grows a second button for it.
 *
 * What it does own is the view config itself (search, facets, group, sort),
 * which it persists and mirrors to the host so the unread status-bar item counts
 * the same rows the list is showing.
 */
export function SidebarApp({ bridge }: { bridge: Bridge }) {
  const [state, setState] = useState<SidebarState | undefined>(undefined)
  const [filterOpen, setFilterOpen] = useState(false)
  const persisted = bridge.getState<Persisted>()
  // Spread over the defaults, not instead of them: a config persisted by an
  // older build is missing whatever fields have been added since.
  const [config, setConfig] = useState<ViewConfig>({
    ...DEFAULT_VIEW_CONFIG,
    ...persisted?.config,
  })

  // The view config outlives a reload — VS Code tears webviews down freely.
  useEffect(() => {
    bridge.setState<Persisted>({ config })
  }, [bridge, config])

  // …and the host mirrors it, so the unread status-bar item counts the rows this
  // list is showing rather than every session on every gateway. One-way: the
  // webview owns the config, the host only reads it.
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
  const filtered = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const groups = useMemo(() => groupRows(filtered, config), [filtered, config])
  const connected = hosts.filter((h) => h.probe === 'connected')
  const scoping = scopeActive(config, scope)
  const subset = subsetSummary(config, scope, filtered.length, rows.length)

  return (
    <div className='flex h-screen flex-col text-body-sm'>
      {/* Behind the title bar's filter toggle. Hidden by default, which is the
          whole reason the subset line below is unconditional: a list that is
          quietly hiding rows must say so even when the control doing it is not
          on screen. */}
      {filterOpen ? (
        <ViewConfigPanel
          config={config}
          hosts={hosts}
          adapters={adapters}
          scope={scope}
          onChange={setConfig}
        />
      ) : null}

      {subset ? <SubsetLine subset={subset} onClear={() => setConfig(clearFilters(config))} /> : null}

      <div className='min-h-0 flex-1 overflow-y-auto py-1'>
        {hosts.length === 0 ? (
          <Empty
            icon={<Plug />}
            title='No gateways yet'
            description={
              <>
                Start one with <code className='font-mono'>npx workerdeck</code>, then add it in the
                Gateways view below.
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
          // Three different nothings, and they want different sentences: the
          // filter matched none, the scope holds none, or there are none.
          subset ? (
            scoping && !hasFacetFilter(config) ? (
              <Empty
                icon={<FolderOpen />}
                title='Nothing in this folder'
                description={`No session is running in ${scope?.label ?? 'this project'}.`}
                action='Show all folders'
                onAction={() => setConfig({ ...config, scoped: false })}
              />
            ) : (
              <Empty
                icon={<SearchX />}
                title='No matches'
                description='No session matches the current search and filters.'
                action='Clear filters'
                onAction={() => setConfig(clearFilters(config))}
              />
            )
          ) : (
            <Empty
              icon={<Layers />}
              title='No sessions yet'
              description={
                <>
                  Start one with <Key>+</Key> above.
                </>
              }
            />
          )
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              {group.label ? (
                <div className='px-2 pb-0.5 pt-2 text-label font-semibold uppercase tracking-wide text-fg-4'>
                  {group.label}
                </div>
              ) : null}
              {group.rows.map((row) => (
                <SessionCard
                  key={row.info.id}
                  info={row.info}
                  unseen={row.unseen}
                  hostName={
                    config.groupBy !== 'gateway' && hosts.length > 1 ? row.hostName : undefined
                  }
                  selected={state?.selected?.sessionId === row.info.id}
                  onSelect={() =>
                    bridge.post({
                      kind: 'wd-select-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
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
                  onStop={() =>
                    bridge.post({
                      kind: 'wd-stop-session',
                      hostId: row.hostId,
                      sessionId: row.info.id,
                    })
                  }
                  onDelete={() =>
                    bridge.post({
                      kind: 'wd-delete-session',
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
