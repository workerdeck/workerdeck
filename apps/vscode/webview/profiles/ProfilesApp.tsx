import { useEffect, useState } from 'react'
import type { WireProfile } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'
import { ProfileList } from './ProfileList.tsx'

export function ProfilesApp({ bridge }: { bridge: Bridge }) {
  const [profiles, setProfiles] = useState<readonly WireProfile[]>([])
  const [gateways, setGateways] = useState(0)

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        if (msg.kind === 'wd-profiles') {
          setProfiles(msg.profiles)
          setGateways(msg.gateways)
        }
      }),
    [bridge],
  )

  // Add and edit are native multi-step inputs on the host: this view is a list and nothing else.
  return (
    <ProfileList
      profiles={profiles}
      showGateway={gateways > 1}
      onEdit={(hostId, name) => bridge.post({ kind: 'wd-edit-profile', hostId, name })}
      onRemove={(hostId, name) => bridge.post({ kind: 'wd-remove-profile', hostId, name })}
    />
  )
}
