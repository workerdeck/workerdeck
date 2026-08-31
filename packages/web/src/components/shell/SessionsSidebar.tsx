import { useMemo, useRef, useState } from 'react'
import { useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { filterRows, sessionLabel, type SessionRow } from '@workerdeck/protocol'
import { Button, Empty, EmptyKey, EngineIcon, SessionBrowser, SessionStatusIcon, cn, toast } from '@workerdeck/ui'
import { Filter, Layers, Plus, RefreshCw } from 'lucide-react'
import { CreateSessionDialog } from '@/views/SessionsView.tsx'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { clientFor, primaryHost } from '@/lib/hosts.ts'
import { getFiltersShown, setFiltersShown } from '@/lib/sidebar.ts'
import { useProjectIcons } from '@workerdeck/react'
import { useSessionRows, useSessions } from '@/hooks/useSessions.ts'
import { useViewConfig } from '@/hooks/useViewConfig.ts'

export function SessionsSidebar() {
  const navigate = useNavigate()
  const activeId = useRouterState({
    select: (s) => s.location.pathname.match(/^\/sessions\/[^/]+\/(.+)$/)?.[1] ?? undefined,
  })
  // `strict: false` because this sidebar sits above the route that declares the param.
  const activeSubagentId = useSearch({ strict: false }).subagent
  const { snapshots, refresh } = useSessions()
  const rows = useSessionRows(snapshots)
  // `clientFor` is module scope and stable, so it is not a dependency that would re-fire the fetch.
  const projectIcons = useProjectIcons(rows, clientFor)
  const failures = snapshots.filter((s) => s.error !== undefined)
  const primary = primaryHost()
  const primarySessions = snapshots.find((snap) => snap.host.id === primary?.id)?.sessions ?? []
  const openCreated = (id: string) => {
    if (!primary) {
      return
    }
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: primary.id, sessionId: id },
      search: {},
    })
  }
  const [config, setConfig] = useViewConfig()
  const [creating, setCreating] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(getFiltersShown)
  // The rail renders rows itself, so it has to apply the filter `SessionBrowser` would: collapsing must not widen the list.
  const visible = useMemo(() => filterRows(rows, config), [rows, config])

  const open = (row: SessionRow) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      // Cleared explicitly, because an omitted `search` inherits the current one and would carry a framed sub-agent along.
      search: {},
    })

  const subagentNonce = useRef(0)
  const openSubagent = (row: SessionRow, toolUseId: string) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      search: { subagent: toolUseId, sn: ++subagentNonce.current },
    })

  const revealNonce = useRef(0)
  const revealStep = (row: SessionRow, toolUseId: string) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      search: { reveal: toolUseId, rn: ++revealNonce.current },
    })

  const rename = (row: SessionRow, title: string) => {
    void clientFor(row.hostId)
      ?.updateSession(row.info.id, { title: title || null })
      .then(() => refresh())
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Rename failed'))
  }

  const create = (
    <Button variant="ghost" size="icon-sm" aria-label="New session" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
    </Button>
  )

  return (
    <>
      <SidebarFrame
        section="sessions"
        title="Sessions"
        railActions={create}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={filtersOpen ? 'Hide filters' : 'Show filters'}
              aria-pressed={filtersOpen}
              onClick={() => {
                setFiltersOpen(!filtersOpen)
                setFiltersShown(!filtersOpen)
              }}
            >
              <Filter className={cn('size-3.5', filtersOpen && 'fill-current text-fg-1')} />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
            </Button>
            {create}
          </>
        }
        rail={visible.map((row) => (
          <button
            key={row.info.id}
            type="button"
            title={`${sessionLabel(row.info)} — ${row.state}`}
            aria-label={sessionLabel(row.info)}
            onClick={() => open(row)}
            className={cn(
              'flex w-full flex-col items-center gap-0.5 border-l-2 py-1.5',
              row.info.id === activeId ? 'border-l-accent bg-row-active' : 'border-l-transparent hover:bg-row-hover',
            )}
          >
            <EngineIcon engine={row.adapter} model={row.info.model} className="size-4" />
            <SessionStatusIcon row={row} />
          </button>
        ))}
      >
        {failures.map(({ host, error }) => (
          <div key={host.id} className="mx-2 mb-2 rounded-md bg-danger-bg px-2 py-1.5 text-label text-danger">
            Can’t reach {host.name}: {error}
          </div>
        ))}

        <SidebarBody>
          <SessionBrowser
            rows={rows}
            config={config}
            onConfigChange={setConfig}
            showControls={filtersOpen}
            projectIcons={projectIcons}
            activeId={activeId}
            activeSubagentId={activeSubagentId}
            onSelect={open}
            onSelectSubagent={openSubagent}
            onRevealStep={revealStep}
            onRename={rename}
            onClearContext={(row) => {
              const client = clientFor(row.hostId)
              if (!client) {
                return
              }
              // A clear is a session command, not a REST route, so this list borrows a socket for one frame.
              // `reconnect: false` is load-bearing: it must not become a second permanent subscriber to the session.
              const handle = client.attach(row.info.id, { reconnect: false })
              const done = setTimeout(() => {
                handle.detach()
                toast.error('Clear failed — the gateway did not answer')
              }, 5_000)
              handle.on('attached', () => {
                handle.clearContext()
                // Let the frame flush before the socket goes, so watchers see the `conversation_reset`.
                setTimeout(() => {
                  clearTimeout(done)
                  handle.detach()
                  toast.success('Context cleared — the previous conversation stays resumable')
                  void refresh()
                }, 150)
              })
            }}
            onDelete={(row) => {
              void clientFor(row.hostId)
                ?.deleteSession(row.info.id)
                .then(() => refresh())
                .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Delete failed'))
            }}
            emptyState={
              <Empty
                icon={<Layers />}
                title="No sessions yet"
                description={
                  <>
                    Start one with <EmptyKey>+</EmptyKey> above.
                  </>
                }
              />
            }
          />
        </SidebarBody>
      </SidebarFrame>

      <CreateSessionDialog
        open={creating}
        onOpenChange={setCreating}
        sessions={primarySessions}
        onCreated={(id) => {
          setCreating(false)
          openCreated(id)
          void refresh()
        }}
      />
    </>
  )
}
