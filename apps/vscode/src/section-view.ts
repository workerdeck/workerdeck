import * as vscode from 'vscode'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { HostStore } from './hosts.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSection, SectionToHost, SidebarState } from './bridge-protocol.ts'
import type { SessionVitals } from '@workerdeck/ui'
import { formatCost } from '@workerdeck/ui/format'
import { webviewHtml } from './webview-html.ts'

export type SectionKind = 'info' | 'context' | 'usage' | 'mcp'

/** What every section view reads from the extension host. */
export type SectionFeed = {
  state: () => SidebarState
  vitals: () => SessionVitals | undefined
}

/**
 * One scoped surface (Session Info / Context / Usage / MCP) as its own VS Code
 * view. A view cannot be disabled or collapsed through the API, so "inert" is said
 * the two ways that exist: the header's `description` (`no session`, `not
 * reported`) and an empty state in the body.
 *
 * All four share one bundle entry; the HTML stamps which section this view is onto
 * the root element. Data is pushed (state + vitals) — the MCP section additionally
 * fetches over its own bridged client, REST only, never an attach.
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
    // push() sets the header description whether or not the webview has announced itself yet.
    this.push()
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.#transports?.dispose()
    })
  }

  async #onMessage(msg: SectionToHost): Promise<void> {
    if (await this.#transports?.handle(msg)) {
      return
    }
    if (msg.kind === 'wd-ready') {
      this.#ready = true
      this.push()
    }
  }

  /** Push current state + vitals (model change, vitals change, ready). */
  push(): void {
    if (!this.#view) {
      return
    }
    // A collapsed view whose body nobody can see still reports whether opening it would show anything.
    this.#view.description = headerDescription(this.#kind, this.#feed.state(), this.#feed.vitals())
    if (!this.#ready) {
      return
    }
    void this.#view.webview.postMessage({
      kind: 'wd-sidebar-state',
      state: this.#feed.state(),
    } satisfies HostToSection)
    void this.#view.webview.postMessage({
      kind: 'wd-vitals',
      vitals: this.#feed.vitals(),
    } satisfies HostToSection)
  }

  /** Re-render this webview from disk — the dev reloader after a rebuild, and a
   * font-setting change (the typeface is baked into the HTML). The webview
   * re-announces `wd-ready`, which is what re-pushes its state. */
  reloadWebview(): void {
    const view = this.#view
    if (!view) {
      return
    }
    this.#ready = false
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
    view.webview.html = webviewHtml(view.webview, dist, 'sections.js', { 'data-view': this.#kind }, ++this.#htmlVersion)
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}

/**
 * What the view header carries to the right of its name: why this view has nothing
 * to show, or the one reading worth having while it is collapsed.
 */
const headerDescription = (kind: SectionKind, state: SidebarState, vitals: SessionVitals | undefined): string | undefined => {
  const selected = state.selected
  const info = selected ? state.sessions[selected.hostId]?.find((s) => s.id === selected.sessionId) : undefined
  if (!info) {
    return 'no session'
  }
  // Live capabilities, then the REST rollup, then the engine's record — the panel's own gating order.
  const caps = vitals?.capabilities ?? info.capabilities ?? ENGINE_CAPABILITIES[info.engine ?? 'claude']
  if (kind === 'context' && !caps.contextUsage) {
    return 'not reported'
  }
  if (kind === 'usage' && !caps.rateLimits) {
    return 'not reported'
  }
  if (kind === 'mcp' && !caps.mcpStatus) {
    return 'not supported'
  }
  // The rollup's number, not a live one: cost lands with the turn result.
  if (kind === 'usage' && info.totalCostUsd !== undefined) {
    return formatCost(info.totalCostUsd)
  }
  return undefined
}
