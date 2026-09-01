import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { GatewaysToHost, HostToGateways, SidebarState } from './bridge-protocol.ts'
import { apiUrl, type HostStore } from './hosts.ts'
import { WebviewHost } from './webview-host.ts'

export type GatewaysFeed = {
  state: () => SidebarState
  refresh: () => Promise<void>
  setWatching: (watching: boolean) => void
}

export class GatewaysViewProvider extends WebviewHost<GatewaysToHost, HostToGateways> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.gateways'
  static readonly formContextKey = 'workerdeck.gatewayFormOpen'

  readonly #store: HostStore
  readonly #feed: GatewaysFeed
  #pendingForm: Extract<HostToGateways, { kind: 'wd-gateway-form' }> | undefined

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
    // The key is global: a disposed view must not leave a back chevron gated on.
    this.#setFormOpen(false)
  }

  #setFormOpen(open: boolean, name?: string): void {
    // `undefined` restores the manifest's name.
    const view = this.view
    if (view) {
      view.title = open ? (name ? `Edit ${name}` : 'Add gateway') : undefined
    }
    void vscode.commands.executeCommand('setContext', GatewaysViewProvider.formContextKey, open)
  }

  back(): void {
    this.#pendingForm = undefined
    this.#setFormOpen(false)
    this.post({ kind: 'wd-gateway-form', open: false })
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

  async reveal(options: { add?: boolean } = {}): Promise<void> {
    if (options.add) {
      this.#pendingForm = { kind: 'wd-gateway-form', open: true }
      this.#setFormOpen(true)
    }
    await vscode.commands.executeCommand(`${GatewaysViewProvider.viewId}.focus`)
    this.#flushForm()
  }

  #flushForm(): void {
    if (!this.#pendingForm || !this.ready) {
      return
    }
    this.post(this.#pendingForm)
    this.#pendingForm = undefined
  }

  protected override onReady(): void {
    this.push()
    this.#flushForm()
  }

  protected override async onMessage(msg: GatewaysToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-submit-gateway': {
        return this.#submit(msg)
      }
      case 'wd-edit-gateway': {
        const host = this.#store.get(msg.hostId)
        if (!host) {
          return
        }
        // SecretStorage is not reachable from a webview, which is why the form is filled by message.
        this.#setFormOpen(true, host.name)
        this.#pendingForm = {
          kind: 'wd-gateway-form',
          open: true,
          gateway: {
            id: host.id,
            name: host.name,
            baseUrl: host.baseUrl,
            authKey: (await this.#store.authKey(host.id)) ?? '',
          },
        }
        this.#flushForm()
        return
      }
      case 'wd-gateway-form-state': {
        this.#setFormOpen(msg.open)
        return
      }
      case 'wd-remove-gateway': {
        return this.#remove(msg.hostId)
      }
    }
  }

  async #submit(msg: Extract<GatewaysToHost, { kind: 'wd-submit-gateway' }>): Promise<void> {
    if (!apiUrl({ baseUrl: msg.baseUrl })) {
      this.post({ kind: 'wd-form-result', ok: false, error: 'not a valid gateway URL' })
      return
    }
    if (!msg.name.trim()) {
      this.post({ kind: 'wd-form-result', ok: false, error: 'name is required' })
      return
    }
    const id = msg.id || randomUUID()
    await this.#store.save({ id, name: msg.name.trim(), baseUrl: msg.baseUrl.trim() }, msg.authKey.trim() || undefined)
    this.post({ kind: 'wd-form-result', ok: true })
    await this.#feed.refresh()
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
