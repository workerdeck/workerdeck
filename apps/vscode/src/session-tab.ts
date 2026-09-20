import * as vscode from 'vscode'
import type { SessionState } from '@workerdeck/protocol'
import type { HostStore } from './hosts.ts'
import { SessionSurface, type SessionRef, type SurfaceDelegate } from './session-surface.ts'

export type TabDelegate = SurfaceDelegate & {
  closed: (tab: SessionEditorTab) => void
}

const STATE_COLORS: Record<SessionState, string> = {
  attention: '#cca700',
  working: '#3794ff',
  idle: '#8b8b8b',
  ended: '#8b8b8b',
}

function stateIcon(state: SessionState): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="${STATE_COLORS[state]}"/></svg>`
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

// A session in an editor tab. Exactly one per session at most (the registry enforces it); the tab
// persists `{ hostId, sessionId, cwd }` through the webview's `setState`, which the serializer
// hands back on window reload.
export class SessionEditorTab extends SessionSurface<vscode.WebviewPanel> implements vscode.Disposable {
  static readonly viewType = 'workerdeck.session'

  readonly kind = 'editor'
  readonly #tabDelegate: TabDelegate
  #panel: vscode.WebviewPanel | undefined
  #state: SessionState = 'idle'
  #disposed = false

  private constructor(extensionUri: vscode.Uri, store: HostStore, delegate: TabDelegate) {
    super(extensionUri, store, delegate)
    this.#tabDelegate = delegate
  }

  static create(
    extensionUri: vscode.Uri,
    store: HostStore,
    delegate: TabDelegate,
    session: SessionRef,
    title: string,
    column: vscode.ViewColumn,
    focus: boolean,
  ): SessionEditorTab {
    const panel = vscode.window.createWebviewPanel(
      SessionEditorTab.viewType,
      title,
      { viewColumn: column, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
      },
    )
    const tab = new SessionEditorTab(extensionUri, store, delegate)
    tab.#adopt(panel, session, title, focus)
    return tab
  }

  static restore(
    extensionUri: vscode.Uri,
    store: HostStore,
    delegate: TabDelegate,
    panel: vscode.WebviewPanel,
    session: SessionRef,
    title: string,
  ): SessionEditorTab {
    const tab = new SessionEditorTab(extensionUri, store, delegate)
    tab.#adopt(panel, session, title, false)
    return tab
  }

  #adopt(panel: vscode.WebviewPanel, session: SessionRef, title: string, focus: boolean): void {
    this.#panel = panel
    panel.title = title
    panel.iconPath = stateIcon(this.#state)
    this.attach(panel)
    this.setSession(session, { focus })
    // A tab VS Code opened or restored active never reports the transition, so read it once here.
    if (panel.active) {
      this.delegate.focused(this)
    }
  }

  protected override wire(panel: vscode.WebviewPanel): void {
    super.wire(panel)
    panel.onDidChangeViewState((e) => {
      this.delegate.visibilityChanged(this)
      if (e.webviewPanel.active) {
        this.delegate.focused(this)
      }
    })
  }

  protected override onViewDisposed(): void {
    super.onViewDisposed()
    this.#panel = undefined
    if (!this.#disposed) {
      this.#disposed = true
      this.#tabDelegate.closed(this)
    }
  }

  get active(): boolean {
    return this.#panel?.active ?? false
  }

  async focus(): Promise<void> {
    this.show()
    this.focusComposer()
  }

  show(column?: vscode.ViewColumn): void {
    this.#panel?.reveal(column, false)
  }

  setTitle(title: string): void {
    if (this.#panel && this.#panel.title !== title) {
      this.#panel.title = title
    }
  }

  setState(state: SessionState): void {
    if (this.#state === state) {
      return
    }
    this.#state = state
    if (this.#panel) {
      this.#panel.iconPath = stateIcon(state)
    }
  }

  dispose(): void {
    this.#disposed = true
    this.disposeTransports()
    this.#panel?.dispose()
    this.#panel = undefined
  }
}
