import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import type { HostStore } from './hosts.ts'
import { apiUrl } from './hosts.ts'
import { clientFor } from './gateway.ts'
import { SessionsModel } from './sessions-model.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSidebar, SidebarToHost } from './bridge-protocol.ts'
import { webviewHtml } from './webview-html.ts'

export type SidebarDelegate = {
  /** A session was chosen — show it in the agent panel. */
  selectSession: (hostId: string, sessionId: string) => Promise<void>
  /** The active session was deleted out from under the panel. */
  clearPanelIfActive: (sessionId: string) => Promise<void>
  activeSessionId: () => string | undefined
}

/**
 * The Sessions webview: management and switching — gateway dropdown, session
 * cards, push-screen forms. The scoped Info/Context/Usage/MCP surfaces are
 * SEPARATE views (`SectionViewProvider`), so VS Code owns their headers,
 * collapse and placement. Data flows one way — the extension host pushes
 * `wd-sidebar-state` on every model change — while actions flow back as
 * intents. The sidebar runs its own bridged `WorkerDeckClient` for form REST
 * (profiles, create) but NEVER attaches: the agent panel owns the one live
 * attach per session.
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'workerdeck.sessions'

  readonly #extensionUri: vscode.Uri
  readonly #store: HostStore
  readonly #model: SessionsModel
  readonly #delegate: SidebarDelegate
  #view: vscode.WebviewView | undefined
  #ready = false
  #htmlVersion = 0
  #transports: WebviewTransportHost | undefined
  /** Queued while the view is closed; delivered on wd-ready. */
  #pendingNavigate: Extract<HostToSidebar, { kind: 'wd-navigate' }> | undefined
  /** Same, for a view-config toggle that arrived before the webview existed. */
  #pendingToggleConfig = false

  constructor(
    extensionUri: vscode.Uri,
    store: HostStore,
    model: SessionsModel,
    delegate: SidebarDelegate,
  ) {
    this.#extensionUri = extensionUri
    this.#store = store
    this.#model = model
    this.#delegate = delegate
    model.onDidChange(() => this.#pushState())
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    this.#transports?.dispose()
    const post = (msg: HostToSidebar) => void view.webview.postMessage(msg)
    this.#transports = new WebviewTransportHost(this.#store, post)
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, 'sidebar.js')
    view.webview.onDidReceiveMessage((msg: SidebarToHost) => void this.#onMessage(msg))
    view.onDidChangeVisibility(() => {
      if (view.visible) this.#model.startPolling()
      else this.#model.stopPolling()
    })
    if (view.visible) this.#model.startPolling()
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
      this.#model.stopPolling()
    })
  }

  #post(msg: HostToSidebar): void {
    void this.#view?.webview.postMessage(msg)
  }

  #pushState(): void {
    if (!this.#view || !this.#ready) return
    this.#post({
      kind: 'wd-sidebar-state',
      state: this.#model.sidebarState(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
    })
    const waiting = this.#model.attentionCount()
    this.#view.badge =
      waiting > 0
        ? { value: waiting, tooltip: `${waiting} session${waiting === 1 ? '' : 's'} awaiting approval` }
        : undefined
  }

  /** Reveal the sidebar and push a screen (commands, tree-parity actions). */
  async navigate(msg: Extract<HostToSidebar, { kind: 'wd-navigate' }>): Promise<void> {
    this.#pendingNavigate = msg
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)
    if (this.#ready) {
      this.#post(msg)
      this.#pendingNavigate = undefined
    }
  }


  /** Show/hide the view config. The icon is a VS Code view-title button, so the
   * toggle can only arrive from the extension host. */
  async toggleViewConfig(): Promise<void> {
    this.#pendingToggleConfig = true
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`)
    if (!this.#ready) return
    this.#pendingToggleConfig = false
    this.#post({ kind: 'wd-toggle-view-config' })
  }

  async #onMessage(msg: SidebarToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) return
    switch (msg.kind) {
      case 'wd-ready':
        this.#ready = true
        this.#pushState()
        if (this.#pendingNavigate) {
          this.#post(this.#pendingNavigate)
          this.#pendingNavigate = undefined
        }
        if (this.#pendingToggleConfig) {
          this.#pendingToggleConfig = false
          this.#post({ kind: 'wd-toggle-view-config' })
        }
        return
      case 'wd-refresh':
        await this.#model.refresh()
        return
      case 'wd-select-session':
        await this.#delegate.selectSession(msg.hostId, msg.sessionId)
        return
      case 'wd-session-created':
        await this.#model.refresh()
        await this.#delegate.selectSession(msg.hostId, msg.sessionId)
        return
      case 'wd-stop-session':
        return this.#stopSession(msg.hostId, msg.sessionId)
      case 'wd-delete-session':
        return this.#deleteSession(msg.hostId, msg.sessionId)
      case 'wd-rename-session':
        return this.#renameSession(msg.hostId, msg.sessionId, msg.title)
      case 'wd-submit-gateway':
        return this.#submitGateway(msg)
      case 'wd-edit-gateway': {
        const host = this.#store.get(msg.hostId)
        if (!host) return
        await this.navigate({
          kind: 'wd-navigate',
          screen: 'gateway',
          gateway: {
            id: host.id,
            name: host.name,
            baseUrl: host.baseUrl,
            authKey: (await this.#store.authKey(host.id)) ?? '',
          },
        })
        return
      }
      case 'wd-remove-gateway':
        return this.#removeGateway(msg.hostId)
    }
  }

  /**
   * Interrupt over a transient attach: connect, send the frame, detach. The
   * agent panel stays the *first* attached client, so the tool bridge (which
   * asks the first) is undisturbed; the window where this transient socket
   * could catch a bridged tool call is accepted for an explicit user action.
   */
  async #stopSession(hostId: string, sessionId: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) return
    await new Promise<void>((resolve) => {
      const handle = client.attach(sessionId, { reconnect: false })
      const timer = setTimeout(() => {
        handle.detach()
        resolve()
      }, 4000)
      handle.on('attached', () => {
        handle.interrupt()
        // Give the frame a beat to flush before tearing the socket down.
        setTimeout(() => {
          clearTimeout(timer)
          handle.detach()
          resolve()
        }, 150)
      })
    })
    await this.#model.refresh()
  }

  /** Rename on the gateway (PATCH), not in this window: the name belongs to the
   * session, so the dashboard and the phone see it too. An empty name clears the
   * override and the derived title comes back. */
  async #renameSession(hostId: string, sessionId: string, title: string): Promise<void> {
    const host = this.#store.get(hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!client) return
    try {
      await client.updateSession(sessionId, { title: title.trim() || null })
    } catch (err) {
      void vscode.window.showErrorMessage(
        `WorkerDeck: rename failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await this.#model.refresh()
  }

  async #deleteSession(hostId: string, sessionId: string): Promise<void> {
    const host = this.#store.get(hostId)
    if (!host) return
    const info = this.#model.sessionsOf(hostId).find((s) => s.id === sessionId)
    const confirmed = await vscode.window.showWarningMessage(
      `Delete session "${info?.title ?? sessionId.slice(0, 8)}"?`,
      { modal: true },
      'Delete',
    )
    if (confirmed !== 'Delete') return
    const client = await clientFor(this.#store, host)
    if (!client) return
    try {
      await client.deleteSession(sessionId)
    } catch (err) {
      void vscode.window.showErrorMessage(
        `WorkerDeck: delete failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await this.#delegate.clearPanelIfActive(sessionId)
    await this.#model.refresh()
  }

  async #submitGateway(msg: Extract<SidebarToHost, { kind: 'wd-submit-gateway' }>): Promise<void> {
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
    await this.#model.refresh()
  }

  async #removeGateway(hostId: string): Promise<void> {
    const host = this.#store.get(hostId)
    if (!host) return
    const confirmed = await vscode.window.showWarningMessage(
      `Remove gateway "${host.name}"? Its auth key is deleted from the keychain.`,
      { modal: true },
      'Remove',
    )
    if (confirmed === 'Remove') await this.#store.remove(hostId)
  }


  /** Dev hot-reload: re-render this webview from the freshly built bundle. The
   * webview re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) return
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'sidebar.js', {}, ++this.#htmlVersion)
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}
