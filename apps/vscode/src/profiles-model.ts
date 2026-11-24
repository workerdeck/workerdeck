import type { ProfileInfo } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { probeFailure } from './gateway.ts'
import { HostSnapshots } from './host-snapshots.ts'
import type { HostStore } from './hosts.ts'
import type { WireProfile } from './bridge-protocol.ts'

type Snapshot = { profiles: ProfileInfo[]; canManage: boolean } | { error: string }

export class ProfilesModel implements vscode.Disposable {
  readonly #store: HostStore
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#onDidChange.event
  readonly #snapshots: HostSnapshots<Snapshot>
  readonly #hosts: vscode.Disposable

  constructor(store: HostStore) {
    this.#store = store
    this.#snapshots = new HostSnapshots(store, {
      load: async (_host, client): Promise<Snapshot> => {
        if (!client) {
          return { error: 'unreachable' }
        }
        try {
          const listed = await client.listProfiles()
          return { profiles: listed.profiles, canManage: listed.canManage === true }
        } catch (err) {
          return { error: probeFailure(err) }
        }
      },
      silent: { error: 'unreachable' },
      landed: () => this.#onDidChange.fire(),
    })
    this.#hosts = store.onDidChange(() => void this.refresh())
  }

  // Not polled, unlike sessions: a profile changes when someone changes it, and the one reading that
  // does move on its own - the gateway's credential probe - is on a ~60s server-side TTL that a
  // refresh action covers. A poll here would be a request per gateway per five seconds for nothing.
  async refresh(): Promise<void> {
    await this.#snapshots.refresh()
    this.#onDidChange.fire()
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
          accountExpiresAt: profile.account?.expiresAt,
        })
      }
    }
    return rows
  }

  dispose(): void {
    this.#hosts.dispose()
    this.#snapshots.dispose()
    this.#onDidChange.dispose()
  }
}
