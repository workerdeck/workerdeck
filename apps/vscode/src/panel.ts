import * as vscode from 'vscode'
import type { HostStore } from './hosts.ts'
import type { PanelToHost } from './bridge-protocol.ts'
import { SessionSurface, sameSession, type SessionRef, type SurfaceDelegate } from './session-surface.ts'

export type PanelDelegate = SurfaceDelegate & {
  // The info state's Focus button: the session the panel last showed now lives in a tab.
  focusHeld: (held: SessionRef) => Promise<void>
  // The panel took a session on or dropped one (the held state counts as dropped).
  sessionChanged: (session: SessionRef | undefined) => void
}

// The bottom Agent panel: always exactly one, may be empty, and never shows a session an editor
// tab holds. When a tab takes its session, the panel keeps a `held` reference so its info state
// can focus the tab, and so closing that tab hands the session back.
export class SessionPanelView extends SessionSurface<vscode.WebviewView> implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'workerdeck.sessionPanel'

  readonly kind = 'panel'
  readonly #panelDelegate: PanelDelegate
  #held: SessionRef | undefined
  #heldTitle: string | undefined

  constructor(extensionUri: vscode.Uri, store: HostStore, delegate: PanelDelegate) {
    super(extensionUri, store, delegate)
    this.#panelDelegate = delegate
  }

  get heldSession(): SessionRef | undefined {
    return this.#held
  }

  holdsOrHeld(hostId: string, sessionId: string): boolean {
    return this.holds(hostId, sessionId) || sameSession(this.#held, hostId, sessionId)
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view)
  }

  protected override wire(view: vscode.WebviewView): void {
    super.wire(view)
    view.onDidChangeVisibility(() => this.delegate.visibilityChanged(this))
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${SessionPanelView.viewId}.focus`)
  }

  // `quiet` neither focuses nor materializes: a session handed back by a closing tab waits for the panel's next showing.
  async show(session: SessionRef | undefined, options: { focus?: boolean; quiet?: boolean } = {}): Promise<void> {
    const existed = !!this.view
    this.#held = undefined
    this.#heldTitle = undefined
    this.setSession(session, { focus: options.focus })
    this.#panelDelegate.sessionChanged(session)
    // Focussing also materializes the view, which is why a first show does it unasked.
    if (session && !options.quiet && (options.focus || !existed)) {
      await this.focus()
    }
    // The first show pushed before the view existed; a view materialized above receives it on `wd-ready`.
    this.pushSession()
  }

  // Deliberately not `show()`, which materializes the view - on activation that would force the dock open on every window start.
  restore(session: SessionRef): void {
    if (this.session) {
      return
    }
    this.setSession(session)
    this.#panelDelegate.sessionChanged(session)
  }

  // A tab took the session: the panel renders "open as an editor tab" until the next single click replaces it.
  hold(session: SessionRef, title: string): void {
    this.#held = session
    this.#heldTitle = title
    this.setSession(undefined)
    this.#panelDelegate.sessionChanged(undefined)
  }

  retitleHeld(title: string): void {
    if (!this.#held || this.#heldTitle === title) {
      return
    }
    this.#heldTitle = title
    this.pushSession()
  }

  protected override held(): { title: string } | undefined {
    return this.#held ? { title: this.#heldTitle ?? this.#held.sessionId.slice(0, 8) } : undefined
  }

  protected override async onMessage(msg: PanelToHost): Promise<void> {
    if (msg.kind === 'wd-focus-held') {
      if (this.#held) {
        await this.#panelDelegate.focusHeld(this.#held)
      }
      return
    }
    await super.onMessage(msg)
  }

  dispose(): void {
    this.disposeTransports()
  }
}
