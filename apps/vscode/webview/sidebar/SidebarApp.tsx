import { Button } from '@workerdeck/ui'
import { ArrowLeft, Plug, Plus } from 'lucide-react'
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
  filterRows,
  groupRows,
  isFiltering,
  type ViewConfig,
} from './view-config.ts'

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
 * sorted by the view config behind the header's filter icon. Gateways are
 * managed on their own screen (the header's plug icon) — the list is a view
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
  const [config, setConfig] = useState<ViewConfig>(persisted?.config ?? DEFAULT_VIEW_CONFIG)
  const [configOpen, setConfigOpen] = useState(persisted?.configOpen ?? false)

  // The view config outlives a reload — VS Code tears webviews down freely.
  useEffect(() => {
    bridge.setState<Persisted>({ config, configOpen })
  }, [bridge, config, configOpen])

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        switch (msg.kind) {
          case 'wd-sidebar-state':
            setState(msg.state)
            return
          case 'wd-toggle-view-config':
            setScreen({ kind: 'list' })
            setConfigOpen((open) => !open)
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
  const rows = useMemo(() => buildRows(state), [state])
  const adapters = useMemo(() => adaptersOf(rows), [rows])
  const groups = useMemo(() => groupRows(filterRows(rows, config), config), [rows, config])
  const connected = hosts.filter((h) => h.probe === 'connected')

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
      {configOpen ? (
        <ViewConfigPanel
          config={config}
          hosts={hosts}
          adapters={adapters}
          onChange={setConfig}
        />
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
          isFiltering(config) ? (
            <Empty
              message='No session matches the current filters.'
              action='Clear filters'
              onClick={() =>
                setConfig({ ...DEFAULT_VIEW_CONFIG, groupBy: config.groupBy, sortBy: config.sortBy })
              }
            />
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
