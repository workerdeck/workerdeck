import { useMemo, useRef, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { filterRows, sessionLabel, type SessionRow } from '@workerdeck/protocol'
import {
  Button,
  Empty,
  EmptyKey,
  EngineIcon,
  SessionBrowser,
  SessionStatusIcon,
  cn,
  toast,
} from '@workerdeck/ui'
import { Filter, Layers, Plus, RefreshCw } from 'lucide-react'
import { CreateSessionDialog } from '@/views/SessionsView.tsx'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { clientFor, primaryHost } from '@/lib/hosts.ts'
import { getFiltersShown, setFiltersShown } from '@/lib/sidebar.ts'
import { useProjectIcons } from '@workerdeck/react'
import { useSessionRows, useSessions } from '@/hooks/useSessions.ts'
import { useViewConfig } from '@/hooks/useViewConfig.ts'

/**
 * The sessions list as a persistent left sidebar — VS Code's explorer, not a
 * page you navigate away from.
 *
 * It lives in the shell rather than in a route so that opening a session does
 * not replace the list: the whole point of the shape is that the next session is
 * one click away while you are reading this one. Mounted only for `/sessions*`,
 * the way VS Code shows the explorer only for the explorer view.
 */
export function SessionsSidebar() {
  const navigate = useNavigate()
  const activeId = useRouterState({
    select: (s) => (s.location.pathname.match(/^\/sessions\/[^/]+\/(.+)$/)?.[1] ?? undefined),
  })
  const { snapshots, refresh } = useSessions()
  const rows = useSessionRows(snapshots)
  // Project icon bytes, per gateway — `clientFor` is module scope and stable,
  // so this is not a dependency that re-fires the fetch effect every render.
  const projectIcons = useProjectIcons(rows, clientFor)
  // Per gateway, so one unreachable gateway names itself instead of the list
  // going quiet or — worse — blaming the ones that are fine.
  const failures = snapshots.filter((s) => s.error !== undefined)
  // Creation targets the primary gateway (see `primaryClient`), so the cwd
  // suggestions come from its sessions and the new session opens under its id.
  const primary = primaryHost()
  const primarySessions =
    snapshots.find((snap) => snap.host.id === primary?.id)?.sessions ?? []
  const openCreated = (id: string) => {
    if (!primary) return
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: primary.id, sessionId: id },
      search: {},
    })
  }
  const [config, setConfig] = useViewConfig()
  const [creating, setCreating] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(getFiltersShown)
  /**
   * The collapsed rail renders rows itself, so it has to apply the same filter
   * `SessionBrowser` would — collapsing must not silently widen the list.
   */
  const visible = useMemo(() => filterRows(rows, config), [rows, config])

  const open = (row: SessionRow) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      // Cleared explicitly: opening the session plainly must leave any framed
      // sub-agent behind, and an omitted `search` would inherit the current one.
      search: {},
    })

  /**
   * A sub-agent under a session: open the session with that agent's own work
   * framed.
   *
   * The nonce is a counter and not the id, because pressing the *same* agent
   * twice has to mean twice — the panel takes this as a request rather than as
   * a controlled value, so a props-equal repeat would do nothing. Navigating
   * with it in the URL is what survives the route change; component state on
   * the far side of a navigation is state the navigation cannot carry.
   */
  const subagentNonce = useRef(0)
  const openSubagent = (row: SessionRow, toolUseId: string) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      search: { subagent: toolUseId, sn: ++subagentNonce.current },
    })

  const rename = (row: SessionRow, title: string) => {
    // A gateway edit, never a local override: the phone and the extension read
    // the same `meta.title`, so a name set here has to reach them.
    void clientFor(row.hostId)
      ?.updateSession(row.info.id, { title: title || null })
      .then(() => refresh())
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Rename failed'))
  }

  const create = (
    <Button variant='ghost' size='icon-sm' aria-label='New session' onClick={() => setCreating(true)}>
      <Plus className='size-4' />
    </Button>
  )

  return (
    <>
      <SidebarFrame
        section='sessions'
        title='Sessions'
        railActions={create}
        actions={
          <>
            {/* The extension's `$(filter)`/`$(filter-filled)` pair: the icon
                fills while the bar is **open**, the way a VS Code title toggle
                does. Whether a filter is actually *set* is the subset line's
                job — it renders below whether or not the bar is open, which is
                what lets closing the bar leave the filters alone without hiding
                the fact. */}
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={filtersOpen ? 'Hide filters' : 'Show filters'}
              aria-pressed={filtersOpen}
              onClick={() => {
                setFiltersOpen(!filtersOpen)
                setFiltersShown(!filtersOpen)
              }}>
              <Filter className={cn('size-3.5', filtersOpen && 'fill-current text-fg-1')} />
            </Button>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label='Refresh'
              onClick={() => void refresh()}>
              <RefreshCw className='size-3.5' />
            </Button>
            {create}
          </>
        }
        // Collapsed, the rail keeps only what identifies a session at a glance:
        // whose engine it is and how it is doing. Everything else — name, model,
        // folder, cost — needs width it no longer has, and a truncated name is
        // worse than no name beside a glyph you can hover.
        rail={visible.map((row) => (
          <button
            key={row.info.id}
            type='button'
            title={`${sessionLabel(row.info)} — ${row.state}`}
            aria-label={sessionLabel(row.info)}
            onClick={() => open(row)}
            className={cn(
              'flex w-full flex-col items-center gap-0.5 border-l-2 py-1.5',
              row.info.id === activeId
                ? 'border-l-accent bg-row-active'
                : 'border-l-transparent hover:bg-row-hover',
            )}>
            <EngineIcon engine={row.adapter} model={row.info.model} className='size-4' />
            <SessionStatusIcon row={row} />
          </button>
        ))}>
        {failures.map(({ host, error }) => (
          <div
            key={host.id}
            className='mx-2 mb-2 rounded-md bg-danger-bg px-2 py-1.5 text-label text-danger'>
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
            onSelect={open}
            onSelectSubagent={openSubagent}
            onRename={rename}
            onDelete={(row) => {
              void clientFor(row.hostId)
                ?.deleteSession(row.info.id)
                .then(() => refresh())
                .catch((e: unknown) =>
                  toast.error(e instanceof Error ? e.message : 'Delete failed'),
                )
            }}
            emptyState={
              <Empty
                icon={<Layers />}
                title='No sessions yet'
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
          // The create call already returned the id, so the list has no reason
          // to wait for its next tick to show what we just made.
          void refresh()
        }}
      />
    </>
  )
}
