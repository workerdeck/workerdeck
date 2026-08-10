import { Button } from '@workerdeck/ui'
import { ArrowLeft, FolderOpen, Plug, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SidebarState } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { GatewayForm } from '../forms/GatewayForm.tsx'
import { NewSessionForm } from '../forms/NewSessionForm.tsx'
import { GatewaysScreen } from './GatewaysScreen.tsx'
import { SessionCard } from './SessionCard.tsx'
import { ViewConfigPanel } from './ViewConfigPanel.tsx'
import {
  DEFAULT_VIEW_CONFIG,
  adaptersOf,
  buildRows,
  clearFilters,
  filterRows,
  groupRows,
  isFiltering,
  scopeActive,
  type ViewConfig,
} from '../../src/view-config.ts'

type Screen =
  | { kind: 'list' }
  | { kind: 'new-session'; hostId?: string }
  | { kind: 'gateways' }
  | { kind: 'gateway'; gateway?: { id: string; name: string; baseUrl: string; authKey: string } }

/** The first gateway most people add is the turnkey one on this machine. */
const LOCAL_GATEWAY_DEFAULTS = { name: 'localhost', baseUrl: 'http://127.0.0.1:8787' }

type Persisted = { config?: ViewConfig; configOpen?: boolean }

/**
 * The Sessions view: every gateway's sessions in one list, filtered/grouped/
 * sorted by the Filter bar above it — which lives in this webview, not in the
 * view title: VS Code's own search-and-filter row (the Extensions view's) is
 * workbench chrome with no extension API, so the closest honest place for it is
 * the first row of the view itself. Gateways are managed on their own screen
 * (the header's plug icon) — the list is a view
 * across all of them, not a picker plus a list. New Session, Add Gateway and the
 * gateway edit form are pushed screens with a back arrow: the closest thing a
 * webview has to a dialog that doesn't cover the work. The scoped surfaces
 * (info/context/usage/MCP) are separate VS Code views, not rendered here.
 */
export function SidebarApp({ bridge }: { bridge: Bridge }) {
  const [state, setState] = useState<SidebarState | undefined>(undefined)
  const [screen, setScreen] = useState<Screen>({ kind: 'list' })
  const [gwError, setGwError] = useState<string | undefined>(undefined)
  const [gwBusy, setGwBusy] = useState(false)
  const persisted = bridge.getState<Persisted>()
  // Spread over the defaults, not instead of them: a config persisted by an
  // older build is missing whatever fields have been added since.
  const [config, setConfig] = useState<ViewConfig>({
    ...DEFAULT_VIEW_CONFIG,
    ...persisted?.config,
  })
  const [configOpen, setConfigOpen] = useState(persisted?.configOpen ?? false)

  // The view config outlives a reload — VS Code tears webviews down freely.
  useEffect(() => {
    bridge.setState<Persisted>({ config, configOpen })
  }, [bridge, config, configOpen])

  // …and the host mirrors it, so the activity-bar badge counts the rows this
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
          case 'wd-navigate':
            setGwError(undefined)
            setGwBusy(false)
            setScreen(
              msg.screen === 'gateway'
                ? { kind: 'gateway', gateway: msg.gateway }
                : msg.screen === 'gateways'
                  ? { kind: 'gateways' }
                  : { kind: 'new-session', hostId: msg.hostId },
            )
            return
          case 'wd-form-result':
            setGwBusy(false)
            if (msg.ok) setScreen({ kind: 'gateways' })
            else setGwError(msg.error ?? 'failed')
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
  // Nothing hidden means an empty list is an empty gateway, not a filter — the
  // two want opposite affordances (create one vs. widen the view).
  const hidden = rows.length - filtered.length
  const connected = hosts.filter((h) => h.probe === 'connected')
  const scoping = scopeActive(config, scope)
  // Scope alone is hiding things — worth saying so plainly, since it is on by
  // default and the rest of the config is behind a toggle.
  const onlyScoped = scoping && !isFiltering({ ...config, scoped: false })

  if (screen.kind === 'new-session') {
    return (
      <PushScreen title='New session' onBack={() => setScreen({ kind: 'list' })}>
        <NewSessionForm
          bridge={bridge}
          hosts={connected}
          preselectedHostId={screen.hostId ?? connected[0]?.id}
          onCreated={(hostId, sessionId) => {
            setScreen({ kind: 'list' })
            bridge.post({ kind: 'wd-session-created', hostId, sessionId })
          }}
          onCancel={() => setScreen({ kind: 'list' })}
        />
      </PushScreen>
    )
  }

  if (screen.kind === 'gateways') {
    return (
      <PushScreen title='Gateways' onBack={() => setScreen({ kind: 'list' })}>
        <GatewaysScreen
          hosts={hosts}
          sessionCounts={Object.fromEntries(
            hosts.map((h) => [h.id, (state?.sessions[h.id] ?? []).length]),
          )}
          onAdd={() => setScreen({ kind: 'gateway' })}
          onEdit={(hostId) => bridge.post({ kind: 'wd-edit-gateway', hostId })}
          onRemove={(hostId) => bridge.post({ kind: 'wd-remove-gateway', hostId })}
        />
      </PushScreen>
    )
  }

  if (screen.kind === 'gateway') {
    return (
      <PushScreen
        title={screen.gateway ? `Edit ${screen.gateway.name}` : 'Add gateway'}
        onBack={() => setScreen({ kind: 'gateways' })}>
        <GatewayForm
          key={screen.gateway?.id ?? 'add'}
          editing={screen.gateway}
          defaults={hosts.length === 0 ? LOCAL_GATEWAY_DEFAULTS : undefined}
          error={gwError}
          busy={gwBusy}
          onSubmit={(msg) => {
            setGwBusy(true)
            setGwError(undefined)
            bridge.post(msg)
          }}
          onCancel={() => setScreen({ kind: 'gateways' })}
        />
      </PushScreen>
    )
  }

  return (
    <div className='flex h-screen flex-col text-body-sm'>
      {/* Always mounted: the bar is the sign that a filter exists at all, and
          this list hides sessions before anyone asks it to. Its own chevron is
          the only toggle — there is no view-title button to keep in sync. */}
      <ViewConfigPanel
        config={config}
        hosts={hosts}
        adapters={adapters}
        scope={scope}
        open={configOpen}
        onOpenChange={setConfigOpen}
        onChange={setConfig}
      />

      {/* The list is scoped by default, so the fact has to be visible without
          opening the config — with the way out on the same line. */}
      {scoping && !configOpen ? (
        <div className='flex items-center gap-1 px-2 py-1 text-label text-fg-4'>
          <FolderOpen className='size-3 shrink-0' />
          <span className='min-w-0 flex-1 truncate'>{scope?.label}</span>
          <button
            type='button'
            onClick={() => setConfig({ ...config, scoped: false })}
            className='shrink-0 underline-offset-2 hover:text-fg-1 hover:underline'>
            Show all
          </button>
        </div>
      ) : null}

      <div className='min-h-0 flex-1 overflow-y-auto py-1'>
        {hosts.length === 0 ? (
          <Empty
            message='No gateways yet. Start one with `npx workerdeck`, then add it here.'
            action='Add gateway'
            icon={<Plug className='size-3.5' />}
            onClick={() => setScreen({ kind: 'gateway' })}
          />
        ) : connected.length === 0 ? (
          <Empty
            message={
              hosts.some((h) => h.probe === 'unauthorized')
                ? 'Unauthorized — check the gateway’s auth key.'
                : hosts.some((h) => h.probe === 'pending')
                  ? 'Connecting…'
                  : 'No gateway reachable. Is `npx workerdeck` running?'
            }
            action='Gateways'
            icon={<Plug className='size-3.5' />}
            onClick={() => setScreen({ kind: 'gateways' })}
          />
        ) : groups.length === 0 ? (
          hidden > 0 ? (
            onlyScoped ? (
              <Empty
                message={`No sessions in ${scope?.label ?? 'this project'}.`}
                action='Show sessions from all folders'
                icon={<FolderOpen className='size-3.5' />}
                onClick={() => setConfig({ ...config, scoped: false })}
              />
            ) : (
              <Empty
                message='No session matches the current filters.'
                action='Clear filters'
                onClick={() => setConfig(clearFilters(config))}
              />
            )
          ) : (
            <Empty
              message='No sessions yet.'
              action='New session'
              icon={<Plus className='size-3.5' />}
              onClick={() => setScreen({ kind: 'new-session' })}
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

function PushScreen({
  title,
  onBack,
  children,
}: {
  title: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className='flex h-screen flex-col'>
      <div className='flex items-center gap-1 border-b border-border p-1.5'>
        <Button variant='ghost' size='icon-sm' aria-label='Back' onClick={onBack}>
          <ArrowLeft className='size-3.5' />
        </Button>
        <span className='text-body-sm font-medium text-fg-1'>{title}</span>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto'>{children}</div>
    </div>
  )
}

function Empty({
  message,
  action,
  icon,
  onClick,
}: {
  message: string
  action: string
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <div className='flex flex-col items-start gap-1 px-3 py-2'>
      <p className='text-body-sm text-fg-4'>{message}</p>
      <Button variant='ghost' size='sm' className='-ml-1.5' onClick={onClick}>
        {icon} {action}
      </Button>
    </div>
  )
}
