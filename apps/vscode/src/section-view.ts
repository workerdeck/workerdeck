import * as vscode from 'vscode'
import type { HostStore } from './hosts.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSection, SectionToHost, SidebarState } from './bridge-protocol.ts'
import type { SessionVitals } from '@workerdeck/ui'
import { webviewHtml } from './webview-html.ts'

export type SectionKind = 'info' | 'context' | 'usage' | 'mcp'

/** What every section view reads from the extension host. */
export type SectionFeed = {
  state: () => SidebarState
  vitals: () => SessionVitals | undefined
}

/**
 * One scoped surface (Session Info / Context / Usage / MCP) as its OWN VS Code
 * view — native header, collapse, drag-to-reorder, drag into the secondary
 * sidebar or panel, right-click visibility: all VS Code's, none of it ours.
 * `when` clauses in the manifest hide a view whose capability the selected
 * session's engine forswears.
 *
 * All four share one bundle entry; the HTML stamps which section this view is
 * onto the root element. Data is pushed (state + vitals) — the MCP section
 * additionally fetches over its own bridged client, REST only, never an attach.
 */
export class SectionViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly #extensionUri: vscode.Uri
  readonly #store: HostStore
  readonly #kind: SectionKind
  readonly #feed: SectionFeed
  #view: vscode.WebviewView | undefined
  #ready = false
  #htmlVersion = 0
  #transports: WebviewTransportHost | undefined

  constructor(extensionUri: vscode.Uri, store: HostStore, kind: SectionKind, feed: SectionFeed) {
    this.#extensionUri = extensionUri
    this.#store = store
    this.#kind = kind
    this.#feed = feed
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    this.#transports?.dispose()
    const post = (msg: HostToSection) => void view.webview.postMessage(msg)
    this.#transports = new WebviewTransportHost(this.#store, post)
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, 'sections.js', { 'data-view': this.#kind })
    view.webview.onDidReceiveMessage((msg: SectionToHost) => void this.#onMessage(msg))
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
    })
  }

  async #onMessage(msg: SectionToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) return
    if (msg.kind === 'wd-ready') {
      this.#ready = true
      this.push()
    }
  }

  /** Push current state + vitals (model change, vitals change, ready). */
  push(): void {
    if (!this.#view || !this.#ready) return
    void this.#view.webview.postMessage({
      kind: 'wd-sidebar-state',
      state: this.#feed.state(),
    } satisfies HostToSection)
    void this.#view.webview.postMessage({
      kind: 'wd-vitals',
      vitals: this.#feed.vitals(),
    } satisfies HostToSection)
  }


  /** Dev hot-reload: re-render this webview from the freshly built bundle. The
   * webview re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) return
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'sections.js', { 'data-view': this.#kind }, ++this.#htmlVersion)
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}
