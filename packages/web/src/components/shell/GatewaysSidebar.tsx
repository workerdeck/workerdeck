import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Button, Empty, EmptyKey, cn } from '@workerdeck/ui'
import { Plus, Server, Trash2 } from 'lucide-react'
import { ConfirmRemoveGateway, CreateGatewayDialog } from '@/components/GatewayForm.tsx'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { RowAction, SidebarRow } from './SidebarRow.tsx'
import { useHosts, type GatewayHost } from '@/lib/hosts.ts'
import { useSessions } from '@/hooks/useSessions.ts'

/** The configured gateways, as their own section sidebar. */
export function GatewaysSidebar() {
  const navigate = useNavigate()
  const activeId = useRouterState({
    select: (s) => s.location.pathname.match(/^\/gateways\/(.+)$/)?.[1],
  })
  const { hosts, ready } = useHosts()
  const { snapshots } = useSessions()
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<GatewayHost | undefined>()

  const connected = snapshots.filter((s) => s.error === undefined).length

  const create = (
    <Button variant="ghost" size="icon-sm" aria-label="Add gateway" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
    </Button>
  )

  return (
    <>
      <SidebarFrame
        section="gateways"
        title="Gateways"
        badge={
          ready && hosts.length > 0 ? (
            <span className="shrink-0 text-label text-fg-4">
              {connected}/{hosts.length}
            </span>
          ) : undefined
        }
        actions={create}
        railActions={create}
      >
        <SidebarBody>
          {ready && hosts.length === 0 ? (
            // No implicit localhost is invented, exactly as the extension refuses to.
            <Empty
              icon={<Server />}
              title="No gateways yet"
              description={
                <>
                  Add one with <EmptyKey>+</EmptyKey> above.
                </>
              }
            />
          ) : null}
          {hosts.map((host) => {
            const snapshot = snapshots.find((s) => s.host.id === host.id)
            const state = snapshot === undefined ? 'pending' : snapshot.error ? 'error' : 'ok'
            return (
              <SidebarRow
                key={host.id}
                active={host.id === activeId}
                onSelect={() => void navigate({ to: '/gateways/$hostId', params: { hostId: host.id } })}
                title={host.name}
                status={
                  <>
                    {host.implicit ? <span className="shrink-0 text-label text-fg-4">this page</span> : null}
                    <span
                      aria-hidden
                      title={snapshot?.error ?? (state === 'ok' ? 'Connected' : 'Connecting…')}
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        state === 'ok' ? 'bg-success' : state === 'error' ? 'bg-danger' : 'bg-fg-4',
                      )}
                    />
                  </>
                }
                description={host.baseUrl}
                actions={
                  // The implicit gateway has nothing to remove: that would just be closing the tab.
                  host.implicit ? null : (
                    <RowAction label={`Remove ${host.name}`} onClick={() => setRemoving(host)}>
                      <Trash2 className="size-3" />
                    </RowAction>
                  )
                }
              />
            )
          })}
        </SidebarBody>
      </SidebarFrame>

      {removing ? (
        <ConfirmRemoveGateway
          host={removing}
          onClose={() => setRemoving(undefined)}
          onRemoved={() => {
            const gone = removing.id === activeId
            setRemoving(undefined)
            // The detail route cannot recover from standing on a gateway that no longer exists.
            if (gone) {
              void navigate({ to: '/gateways' })
            }
          }}
        />
      ) : null}

      <CreateGatewayDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(host) => {
          setCreating(false)
          void navigate({ to: '/gateways/$hostId', params: { hostId: host.id } })
        }}
      />
    </>
  )
}
