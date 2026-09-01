import * as vscode from 'vscode'
import type { GatewaysToHost, HostToGateways, SidebarState } from './bridge-protocol.ts'
import type { HostStore } from './hosts.ts'
import { WebviewHost } from './webview-host.ts'

export type GatewaysFeed = {
  state: () => SidebarState
  refresh: () => Promise<void>
  setWatching: (watching: boolean) => void
  edit: (hostId: string) => Promise<void>
}

export class GatewaysViewProvider extends WebviewHost<GatewaysToHost, HostToGateways> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.gateways'

  readonly #store: HostStore
  readonly #feed: GatewaysFeed

  protected readonly bundle = 'gateways.js'

  constructor(extensionUri: vscode.Uri, store: HostStore, feed: GatewaysFeed) {
    super(extensionUri)
    this.#store = store
    this.#feed = feed
  }

  protected override wire(view: vscode.WebviewView): void {
    view.onDidChangeVisibility(() => this.#feed.setWatching(view.visible))
    this.#feed.setWatching(view.visible)
  }

  protected override afterResolve(): void {
    this.push()
  }

  protected override onViewDisposed(): void {
    this.#feed.setWatching(false)
  }

  push(): void {
    const view = this.view
    if (!view) {
      return
    }
    const state = this.#feed.state()
    const connected = state.hosts.filter((h) => h.probe === 'connected').length
    view.description =
      state.hosts.length === 0 ? 'none' : connected === state.hosts.length ? String(connected) : `${connected}/${state.hosts.length}`
    if (!this.ready) {
      return
    }
    this.post({
      kind: 'wd-gateways',
      hosts: state.hosts,
      sessionCounts: Object.fromEntries(state.hosts.map((h) => [h.id, (state.sessions[h.id] ?? []).length])),
    })
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${GatewaysViewProvider.viewId}.focus`)
  }

  protected override onReady(): void {
    this.push()
  }

  protected override async onMessage(msg: GatewaysToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-edit-gateway': {
        // The add/edit flow is a native multi-step input, the same shape session creation has:
        // this view is a list and nothing else.
        return this.#feed.edit(msg.hostId)
      }
      case 'wd-remove-gateway': {
        return this.#remove(msg.hostId)
      }
    }
  }

  async #remove(hostId: string): Promise<void> {
    const host = this.#store.get(hostId)
    if (!host) {
      return
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Remove gateway "${host.name}"? Its auth key is deleted from the keychain.`,
      { modal: true },
      'Remove',
    )
    if (confirmed === 'Remove') {
      await this.#store.remove(hostId)
    }
  }

  dispose(): void {}
}
