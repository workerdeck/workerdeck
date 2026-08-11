import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { GatewaysToHost, HostToGateways, SidebarState } from './bridge-protocol.ts'
import { apiUrl, type HostStore } from './hosts.ts'
import { webviewHtml } from './webview-html.ts'

/** What the Gateways view reads from, and reports to, the extension host. */
export type GatewaysFeed = {
  state: () => SidebarState
  /** The gateway set changed — re-probe now rather than waiting for a poll. */
  refresh: () => Promise<void>
  /**
   * Whether this view needs fresh probe readings. It is collapsible on its own,
   * and the poll used to be gated on the sessions list alone — so with that list
   * collapsed this view would show every gateway stuck at `pending`, which is
   * the single question it exists to answer.
   */
  setWatching: (watching: boolean) => void
}

/**
 * The Gateways view: the gateways this window can drive, as its OWN VS Code view
 * in the WorkerDeck container.
 *
 * It used to be a screen the sessions list pushed over itself, reached from a
 * plug icon in that view's title. That was the wrong shape twice over. A gateway
 * is a **mode** — every session belongs to one, and gateway is a filter facet on
 * the list — so managing them is configuration that should sit beside the list,
 * permanently, rather than replacing it. And a pushed screen is somewhere you
 * can be stranded: the list vanished, the native title still said SESSIONS, and
 * the only way back was a chevron this extension drew itself.
 *
 * As a view it gets VS Code's own header, collapse state, drag-to-reorder and
 * right-click visibility — the same deal the four scoped section views already
 * take. It is `visibility: "collapsed"` in the manifest, so a fresh install sees
 * the header without spending rows on it, and the header's `description` carries
 * the count so a collapsed view still reports whether anything is connected.
 *
 * Like the sessions list, it draws no header: the form it opens one level deep
 * is announced with `wd-gateway-form-state`, and this side answers by retitling
 * the view and swapping its `+` for a back chevron. No webview in this extension
 * owns its own chrome.
 *
 * **No transports.** Saving a gateway is globalState plus the OS keychain, both
 * host-side; this webview runs no `WorkerDeckClient` and has no route to a
 * gateway. Auth keys reach it exactly once, prefilled into an edit form, and
 * only because the person asked to edit that gateway.
 */
export class GatewaysViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'workerdeck.gateways'
  /** Gates the view title's `+` against its back chevron — see `SidebarProvider`
   * for why a stateful title button has to be a context key. */
  static readonly formContextKey = 'workerdeck.gatewayFormOpen'

  readonly #extensionUri: vscode.Uri
  readonly #store: HostStore
  readonly #feed: GatewaysFeed
  #view: vscode.WebviewView | undefined
  #ready = false
  #htmlVersion = 0
  /** Queued while the view is closed or still booting; delivered on wd-ready. */
  #pendingForm: Extract<HostToGateways, { kind: 'wd-gateway-form' }> | undefined

  constructor(extensionUri: vscode.Uri, store: HostStore, feed: GatewaysFeed) {
    this.#extensionUri = extensionUri
    this.#store = store
    this.#feed = feed
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, 'gateways.js')
    view.webview.onDidReceiveMessage((msg: GatewaysToHost) => void this.#onMessage(msg))
    view.onDidChangeVisibility(() => this.#feed.setWatching(view.visible))
    this.#feed.setWatching(view.visible)
    // The header can be right before the body exists.
    this.push()
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#feed.setWatching(false)
      // The key is global; a disposed view must not leave a back chevron gated
      // on for whichever view resolves next.
      this.#setFormOpen(false)
    })
  }

  /** Dress the view for the form being open or closed: its title, and the key
   * the manifest gates the title actions on. */
  #setFormOpen(open: boolean, name?: string): void {
    // `undefined` restores the manifest's name.
    if (this.#view) this.#view.title = open ? (name ? `Edit ${name}` : 'Add gateway') : undefined
    void vscode.commands.executeCommand(
      'setContext',
      GatewaysViewProvider.formContextKey,
      open,
    )
  }

  /** The back chevron — it is a title-bar command, so this side presses it. */
  back(): void {
    this.#pendingForm = undefined
    this.#setFormOpen(false)
    this.#post({ kind: 'wd-gateway-form', open: false })
  }

  #post(msg: HostToGateways): void {
    void this.#view?.webview.postMessage(msg)
  }

  /** Push the gateway list (a host change, a sessions poll, or `wd-ready`). */
  push(): void {
    if (!this.#view) return
    const state = this.#feed.state()
    const connected = state.hosts.filter((h) => h.probe === 'connected').length
    // Said while collapsed, which is the point: whether anything is reachable is
    // the one fact about this view worth having without opening it.
    this.#view.description =
      state.hosts.length === 0
        ? 'none'
        : connected === state.hosts.length
          ? String(connected)
          : `${connected}/${state.hosts.length}`
    if (!this.#ready) return
    this.#post({
      kind: 'wd-gateways',
      hosts: state.hosts,
      sessionCounts: Object.fromEntries(
        state.hosts.map((h) => [h.id, (state.sessions[h.id] ?? []).length]),
      ),
    })
  }

  /** Reveal the view, and optionally open its add form — the `+` title action,
   * the palette commands, and the sessions list's empty states. */
  async reveal(options: { add?: boolean } = {}): Promise<void> {
    if (options.add) {
      this.#pendingForm = { kind: 'wd-gateway-form', open: true }
      this.#setFormOpen(true)
    }
    await vscode.commands.executeCommand(`${GatewaysViewProvider.viewId}.focus`)
    this.#flushForm()
  }

  #flushForm(): void {
    if (!this.#pendingForm || !this.#ready) return
    this.#post(this.#pendingForm)
    this.#pendingForm = undefined
  }

  async #onMessage(msg: GatewaysToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-ready':
        this.#ready = true
        this.push()
        this.#flushForm()
        return
      case 'wd-submit-gateway':
        return this.#submit(msg)
      case 'wd-edit-gateway': {
        const host = this.#store.get(msg.hostId)
        if (!host) return
        // The key can only come from here — SecretStorage is not reachable from
        // a webview, which is the whole reason the form is filled by a message.
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
      case 'wd-gateway-form-state':
        // The webview is the authority on whether the form is up (it closes on
        // cancel and on a successful save); this side only dresses the frame.
        this.#setFormOpen(msg.open)
        return
      case 'wd-remove-gateway':
        return this.#remove(msg.hostId)
    }
  }

  async #submit(msg: Extract<GatewaysToHost, { kind: 'wd-submit-gateway' }>): Promise<void> {
    if (!apiUrl({ baseUrl: msg.baseUrl })) {
      this.#post({ kind: 'wd-form-result', ok: false, error: 'not a valid gateway URL' })
      return
    }
    if (!msg.name.trim()) {
      this.#post({ kind: 'wd-form-result', ok: false, error: 'name is required' })
      return
    }
    const id = msg.id || randomUUID()
    await this.#store.save(
      { id, name: msg.name.trim(), baseUrl: msg.baseUrl.trim() },
      msg.authKey.trim() || undefined,
    )
    this.#post({ kind: 'wd-form-result', ok: true })
    await this.#feed.refresh()
  }

  async #remove(hostId: string): Promise<void> {
    const host = this.#store.get(hostId)
    if (!host) return
    const confirmed = await vscode.window.showWarningMessage(
      `Remove gateway "${host.name}"? Its auth key is deleted from the keychain.`,
      { modal: true },
      'Remove',
    )
    if (confirmed === 'Remove') await this.#store.remove(hostId)
  }

  /** Re-render this webview from disk — the dev reloader after a rebuild. The
   * webview re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) return
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'gateways.js', {}, ++this.#htmlVersion)
  }

  dispose(): void {}
}
