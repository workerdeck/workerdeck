import * as vscode from 'vscode'
import type { HostToProfiles, ProfilesToHost } from './bridge-protocol.ts'
import type { ProfilesModel } from './profiles-model.ts'
import { WebviewViewHost } from './webview-host.ts'

export type ProfilesFeed = {
  refresh: () => Promise<void>
  add: (hostId: string) => Promise<void>
  edit: (hostId: string, name: string) => Promise<void>
  remove: (hostId: string, name: string) => Promise<void>
}

export class ProfilesViewProvider extends WebviewViewHost<ProfilesToHost, HostToProfiles> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.profiles'

  readonly #model: ProfilesModel
  readonly #feed: ProfilesFeed

  protected readonly bundle = 'profiles.js'

  constructor(extensionUri: vscode.Uri, model: ProfilesModel, feed: ProfilesFeed) {
    super(extensionUri)
    this.#model = model
    this.#feed = feed
  }

  // Profiles are not polled, so becoming visible is the one moment a stale list has to be corrected.
  protected override wire(view: vscode.WebviewView): void {
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.#feed.refresh()
      }
    })
  }

  protected override afterResolve(): void {
    this.push()
    void this.#feed.refresh()
  }

  push(): void {
    const view = this.view
    if (!view) {
      return
    }
    const profiles = this.#model.rows()
    const gateways = new Set(profiles.map((p) => p.hostId)).size
    view.description = profiles.length === 0 ? 'none' : String(profiles.length)
    if (!this.ready) {
      return
    }
    this.post({ kind: 'wd-profiles', profiles, gateways })
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${ProfilesViewProvider.viewId}.focus`)
  }

  protected override onReady(): void {
    this.push()
  }

  protected override async onMessage(msg: ProfilesToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-add-profile': {
        return this.#feed.add(msg.hostId)
      }
      case 'wd-edit-profile': {
        return this.#feed.edit(msg.hostId, msg.name)
      }
      case 'wd-remove-profile': {
        return this.#feed.remove(msg.hostId, msg.name)
      }
    }
  }

  dispose(): void {}
}
