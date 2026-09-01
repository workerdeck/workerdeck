import * as vscode from 'vscode'
import { webviewHtml } from './webview-html.ts'

/**
 * The webview-provider skeleton shared by the panel, the sidebar, the section views and the
 * gateways view: the `#view`/`#ready`/`#htmlVersion` triple, `resolveWebviewView`'s
 * options + HTML + message wiring, the `wd-ready` flip, and the dev reloader's
 * `reloadWebview()`. Getting the ready/push ordering right is this class's whole job:
 * `ready` is false from resolve until the webview says `wd-ready`, and it is the subclass's
 * `onReady()` that re-pushes whatever the fresh document missed.
 *
 * `In` is the webview→host message union (it must include `{ kind: 'wd-ready' }`),
 * `Out` the host→webview one.
 */
export abstract class WebviewHost<In extends { kind: string }, Out> implements vscode.WebviewViewProvider {
  readonly #extensionUri: vscode.Uri
  #view: vscode.WebviewView | undefined
  #ready = false
  // Bumped by the dev reloader: identical HTML would not re-fetch the bundle.
  #htmlVersion = 0

  constructor(extensionUri: vscode.Uri) {
    this.#extensionUri = extensionUri
  }

  /** The webview bundle name under dist/webview, e.g. 'sidebar.js'. */
  protected abstract readonly bundle: string

  /** Attributes stamped on `#root`. Called per (re)load so live config reads stay live. */
  protected rootAttrs(): Record<string, string> {
    return {}
  }

  /** Extra webviewHtml options (the panel loads the editor font). */
  protected htmlOptions(): { font?: boolean } {
    return {}
  }

  /**
   * Wire per-view listeners (transports, visibility) on the fresh view. Runs inside
   * `resolveWebviewView` before the HTML is set, matching the original providers.
   */
  protected wire(_view: vscode.WebviewView): void {}

  /** Runs after the view is fully wired — the place for an eager first push. */
  protected afterResolve(): void {}

  /** First shot at every message (the transport bridge). Return true when consumed. */
  protected intercept(_msg: In): Promise<boolean> | boolean {
    return false
  }

  /** The `wd-ready` arm: `ready` is already true — re-push what the fresh document missed. */
  protected abstract onReady(): void

  /** Every message neither the interceptor nor `wd-ready` consumed. */
  protected abstract onMessage(msg: In): Promise<void> | void

  /** Cleanup when VS Code disposes the view (the view/ready reset has already happened). */
  protected onViewDisposed(): void {}

  protected get view(): vscode.WebviewView | undefined {
    return this.#view
  }

  protected get ready(): boolean {
    return this.#ready
  }

  protected post(msg: Out): void {
    void this.#view?.webview.postMessage(msg)
  }

  #dist(): vscode.Uri {
    return vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview')
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view
    this.#ready = false
    this.wire(view)
    const dist = this.#dist()
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] }
    view.webview.html = webviewHtml(view.webview, dist, this.bundle, this.rootAttrs(), 0, this.htmlOptions())
    view.webview.onDidReceiveMessage((msg: In) => void this.#dispatch(msg))
    view.onDidDispose(() => {
      this.#view = undefined
      this.#ready = false
      this.onViewDisposed()
    })
    this.afterResolve()
  }

  async #dispatch(msg: In): Promise<void> {
    if (await this.intercept(msg)) {
      return
    }
    if (msg.kind === 'wd-ready') {
      this.#ready = true
      this.onReady()
      return
    }
    await this.onMessage(msg)
  }

  // Development-mode only (see dev-reload.ts): re-renders the webview in place after a
  // bundle rebuild. The version bump busts the script URL; `ready` drops until the fresh
  // document says `wd-ready` again.
  reloadWebview(): void {
    const view = this.#view
    if (!view) {
      return
    }
    this.#ready = false
    view.webview.html = webviewHtml(view.webview, this.#dist(), this.bundle, this.rootAttrs(), ++this.#htmlVersion, this.htmlOptions())
  }
}
