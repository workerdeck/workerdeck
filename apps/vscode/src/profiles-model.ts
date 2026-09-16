import type { ProfileInfo } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import type { WireProfile } from './bridge-protocol.ts'

type Snapshot = { profiles: ProfileInfo[]; canManage: boolean } | { error: string }

export class ProfilesModel implements vscode.Disposable {
  readonly #store: HostStore
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#onDidChange.event
  readonly #snapshots = new Map<string, Snapshot>()
  readonly #hosts: vscode.Disposable
  #refreshing = false

  constructor(store: HostStore) {
    this.#store = store
    this.#hosts = store.onDidChange(() => void this.refresh())
  }

  // Not polled, unlike sessions: a profile changes when someone changes it, and the one reading that
  // does move on its own — the gateway's credential probe — is on a ~60s server-side TTL that a
  // refresh action covers. A poll here would be a request per gateway per five seconds for nothing.
  async refresh(): Promise<void> {
    if (this.#refreshing) {
      return
    }
    this.#refreshing = true
    try {
      const hosts = this.#store.all()
      await Promise.all(
        hosts.map(async (host) => {
          const client = await clientFor(this.#store, host)
          if (!client) {
            this.#snapshots.set(host.id, { error: 'unreachable' })
            return
          }
          try {
            const listed = await client.listProfiles()
            this.#snapshots.set(host.id, { profiles: listed.profiles, canManage: listed.canManage === true })
          } catch (err) {
            const status = (err as { status?: number }).status
            this.#snapshots.set(host.id, { error: status === 401 || status === 403 ? 'unauthorized' : 'unreachable' })
          }
        }),
      )
      for (const id of this.#snapshots.keys()) {
        if (!hosts.some((h) => h.id === id)) {
          this.#snapshots.delete(id)
        }
      }
      this.#onDidChange.fire()
    } finally {
      this.#refreshing = false
    }
  }

  rows(): WireProfile[] {
    const rows: WireProfile[] = []
    for (const host of this.#store.all()) {
      const snap = this.#snapshots.get(host.id)
      if (!snap || 'error' in snap) {
        continue
      }
      for (const profile of snap.profiles) {
        rows.push({
          hostId: host.id,
          hostName: host.name,
          name: profile.name,
          engine: profile.engine ?? 'claude',
          managed: profile.managed === true,
          canManage: snap.canManage,
          configDir: profile.configDir ?? profile.codexHome,
          description: profile.description,
          available: profile.available,
          unavailableReason: profile.unavailableReason,
          defaultModel: profile.defaults?.model,
          defaultPermissionMode: profile.defaults?.permissionMode,
        })
      }
    }
    return rows
  }

  dispose(): void {
    this.#hosts.dispose()
    this.#onDidChange.dispose()
  }
}
