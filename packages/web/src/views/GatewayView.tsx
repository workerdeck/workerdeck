import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, toast } from '@workerdeck/ui'
import { Trash2 } from 'lucide-react'
import { ConfirmRemoveGateway, GatewayFields } from '@/components/GatewayForm.tsx'
import { DetailBar, DetailBody } from '@/components/shell/DetailBar.tsx'
import { isLocal, useHosts } from '@/lib/hosts.ts'
import { useSessions } from '@/hooks/useSessions.ts'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-baseline justify-between gap-4 py-1.5'>
      <span className='shrink-0 text-label font-medium text-fg-3'>{label}</span>
      <span className='min-w-0 text-right text-body-sm text-fg-1'>{children}</span>
    </div>
  )
}

/**
 * One gateway: how it is doing, and — unless it is the one that served this page
 * — the form that edits it.
 *
 * The implicit gateway has nothing to edit. Its address is this page's own
 * origin and its credential is the cookie it already set, so the form would be
 * three disabled fields pretending otherwise.
 */
export function GatewayView() {
  const { hostId } = useParams({ from: '/gateways/$hostId' })
  const navigate = useNavigate()
  const { hosts, ready } = useHosts()
  const { snapshots } = useSessions()
  const [removing, setRemoving] = useState(false)

  const host = hosts.find((h) => h.id === hostId)
  const snapshot = snapshots.find((s) => s.host.id === hostId)

  useEffect(() => {
    // Not until the same-origin probe has answered: the implicit gateway does
    // not exist yet at first paint, and bouncing off it would break its links.
    if (!ready || host) return
    void navigate({ to: '/gateways' })
  }, [ready, host, navigate])

  if (!host) return null

  const state = snapshot === undefined ? 'pending' : snapshot.error ? 'error' : 'ok'

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <DetailBar
        crumbs={[{ label: 'Gateways', to: '/gateways' }, { label: host.name }]}
        actions={
          host.implicit ? null : (
            <Button variant='outline' size='xs' onClick={() => setRemoving(true)}>
              <Trash2 className='size-3' />
              Remove
            </Button>
          )
        }>
        <span className='min-w-0 truncate font-mono text-label text-fg-4' title={host.baseUrl}>
          {host.baseUrl}
        </span>
      </DetailBar>

      <DetailBody>
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col divide-y divide-border'>
            <Row label='Status'>
              {state === 'ok' ? (
                <Badge variant='success' dot>
                  Connected
                </Badge>
              ) : state === 'error' ? (
                <Badge variant='danger' dot>
                  Unreachable
                </Badge>
              ) : (
                <Badge variant='neutral' dot>
                  Connecting…
                </Badge>
              )}
            </Row>
            {snapshot?.error ? (
              <Row label='Last error'>
                <span className='text-danger'>{snapshot.error}</span>
              </Row>
            ) : null}
            <Row label='Live sessions'>
              {snapshot ? snapshot.sessions.length : <span className='text-fg-4'>—</span>}
            </Row>
            {/* Decided from the URL, never by probing paths — the rule
                `isLoopbackHost` exists to keep identical across clients. */}
            <Row label='Reachability'>
              {isLocal(host) ? 'This machine (loopback)' : 'Remote'}
            </Row>
            <Row label='Credential'>
              {host.implicit ? (
                <span className='text-fg-4'>the login cookie it set — same origin</span>
              ) : (
                <span className='text-fg-4'>an auth key held in this browser</span>
              )}
            </Row>
          </CardContent>
        </Card>

        {host.implicit ? (
          <p className='text-label text-fg-4'>
            This is the gateway that served the page. Its address is this origin and its
            credential is the cookie it already set, so there is nothing here to change — and
            nothing to remove, since removing it would just be closing the tab.
          </p>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Settings</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Keyed on the host id so switching gateways in the sidebar
                  re-seeds the fields instead of leaving the previous one's
                  values in a form now labelled with a different name. */}
              <GatewayFields key={host.id} host={host} onSaved={(saved) => toast.success(`Saved ${saved.name}`)} />
            </CardContent>
          </Card>
        )}

        {removing ? (
          <ConfirmRemoveGateway
            host={host}
            onClose={() => setRemoving(false)}
            onRemoved={() => {
              setRemoving(false)
              void navigate({ to: '/gateways' })
            }}
          />
        ) : null}
      </DetailBody>
    </div>
  )
}
