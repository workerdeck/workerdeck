import { useEffect, useState } from 'react'
import type { WireHost } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { GatewayForm, type GatewayFormValue } from './GatewayForm.tsx'
import { GatewayList } from './GatewayList.tsx'

const LOCAL_GATEWAY_DEFAULTS = { name: 'localhost', baseUrl: 'http://127.0.0.1:8787' }

type Form = { editing?: GatewayFormValue }

export function GatewaysApp({ bridge }: { bridge: Bridge }) {
  const [hosts, setHosts] = useState<readonly WireHost[]>([])
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({})
  const [form, setForm] = useState<Form | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  // The host owns this view's title bar, so it has to know when the form is up.
  useEffect(() => {
    bridge.post({ kind: 'wd-gateway-form-state', open: form !== undefined })
  }, [bridge, form])

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        switch (msg.kind) {
          case 'wd-gateways': {
            setHosts(msg.hosts)
            setSessionCounts(msg.sessionCounts)
            return
          }
          case 'wd-gateway-form': {
            // The host opens the form for an edit (it holds the key) and for the `+`; closing it is this side's only call.
            setError(undefined)
            setBusy(false)
            setForm(msg.open ? { editing: msg.gateway } : undefined)
            return
          }
          case 'wd-form-result': {
            setBusy(false)
            if (msg.ok) {
              setForm(undefined)
            } else {
              setError(msg.error ?? 'failed')
            }
            return
          }
        }
      }),
    [bridge],
  )

  if (form) {
    return (
      <GatewayForm
        key={form.editing?.id ?? 'add'}
        editing={form.editing}
        defaults={hosts.length === 0 ? LOCAL_GATEWAY_DEFAULTS : undefined}
        error={error}
        busy={busy}
        onSubmit={(msg) => {
          setBusy(true)
          setError(undefined)
          bridge.post(msg)
        }}
        onCancel={() => setForm(undefined)}
      />
    )
  }

  return (
    <GatewayList
      hosts={hosts}
      sessionCounts={sessionCounts}
      onEdit={(hostId) => bridge.post({ kind: 'wd-edit-gateway', hostId })}
      onRemove={(hostId) => bridge.post({ kind: 'wd-remove-gateway', hostId })}
    />
  )
}
