import { useEffect, useState } from 'react'
import type { WireHost } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { GatewayList } from './GatewayList.tsx'

export function GatewaysApp({ bridge }: { bridge: Bridge }) {
  const [hosts, setHosts] = useState<readonly WireHost[]>([])
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({})

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        if (msg.kind === 'wd-gateways') {
          setHosts(msg.hosts)
          setSessionCounts(msg.sessionCounts)
        }
      }),
    [bridge],
  )

  // Add and edit are native multi-step inputs on the host: this view is a list and nothing else.
  return (
    <GatewayList
      hosts={hosts}
      sessionCounts={sessionCounts}
      onEdit={(hostId) => bridge.post({ kind: 'wd-edit-gateway', hostId })}
      onRemove={(hostId) => bridge.post({ kind: 'wd-remove-gateway', hostId })}
    />
  )
}
