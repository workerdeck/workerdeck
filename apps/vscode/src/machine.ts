import { createHash } from 'node:crypto'
import { arch, homedir, hostname, platform } from 'node:os'
import { clientFor } from './gateway.ts'
import { isLoopbackHost, type GatewayHost, type HostStore } from './hosts.ts'

let ours: string | undefined

// Byte for byte `packages/server/src/lib/machine-id.ts`. The extension must not import the server,
// so the two live apart and must be changed together: a drift only shows up as "local files stopped
// opening natively", never as a failure.
//
// In a Remote SSH window this runs on the remote box, which is exactly the machine whose `file:`
// paths that window can open - so the comparison stays right without knowing about remotes at all.
function localMachineId(): string {
  ours ??= createHash('sha256').update([hostname(), platform(), arch(), homedir()].join('\0')).digest('hex').slice(0, 32)
  return ours
}

// Keyed by gateway id, but remembered against the URL it was measured at: re-pointing a gateway at a
// different box keeps its id, and the stale answer would open that box's paths as local files.
const known = new Map<string, { baseUrl: string; local: boolean }>()
const inFlight = new Map<string, Promise<boolean>>()

function remembered(host: GatewayHost): boolean | undefined {
  const hit = known.get(host.id)
  return hit?.baseUrl === host.baseUrl ? hit.local : undefined
}

// Synchronous readers (the sidebar view model) get the last answer or the loopback fallback; nothing
// blocks a render on a round trip.
export function isLocalHostCached(host: GatewayHost): boolean {
  return remembered(host) ?? isLoopbackHost(host)
}

export async function isLocalHost(store: HostStore, host: GatewayHost): Promise<boolean> {
  if (isLoopbackHost(host)) {
    return true
  }
  return remembered(host) ?? (await refreshLocality(store, host))
}

export async function refreshLocality(store: HostStore, host: GatewayHost): Promise<boolean> {
  if (isLoopbackHost(host)) {
    known.set(host.id, { baseUrl: host.baseUrl, local: true })
    return true
  }
  const pending = inFlight.get(host.id)
  if (pending) {
    return pending
  }
  const work = (async () => {
    try {
      const client = await clientFor(store, host)
      const meta = await client?.meta()
      // A gateway that predates `/meta`, or answers a non-operator principal, has no fingerprint to
      // match - which is the remote answer, the one that was always taken before.
      const local = meta?.machineId !== undefined && meta.machineId === localMachineId()
      known.set(host.id, { baseUrl: host.baseUrl, local })
      return local
    } catch {
      return remembered(host) ?? false
    } finally {
      inFlight.delete(host.id)
    }
  })()
  inFlight.set(host.id, work)
  return work
}

export function forgetLocality(hostId: string): void {
  known.delete(hostId)
  inFlight.delete(hostId)
}
