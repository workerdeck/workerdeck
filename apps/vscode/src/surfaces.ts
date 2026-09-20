import * as vscode from 'vscode'
import type { AnySurface } from './session-surface.ts'
import type { SessionPanelView } from './panel.ts'
import type { SessionEditorTab } from './session-tab.ts'

// Every surface a session can live in, and which one is focused. Focus is sticky: it moves only
// when a surface reports itself active, never when the user clicks into a text editor.
export class SurfaceRegistry implements vscode.Disposable {
  readonly panel: SessionPanelView
  readonly #tabs = new Set<SessionEditorTab>()
  #focused: AnySurface
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#onDidChange.event
  readonly #onDidChangeFocus = new vscode.EventEmitter<AnySurface>()
  readonly onDidChangeFocus = this.#onDidChangeFocus.event

  constructor(panel: SessionPanelView) {
    this.panel = panel
    this.#focused = panel
  }

  get focused(): AnySurface {
    return this.#focused
  }

  all(): AnySurface[] {
    return [this.panel, ...this.#tabs]
  }

  tabs(): SessionEditorTab[] {
    return [...this.#tabs]
  }

  find(hostId: string, sessionId: string): AnySurface | undefined {
    return this.all().find((surface) => surface.holds(hostId, sessionId))
  }

  tabFor(hostId: string, sessionId: string): SessionEditorTab | undefined {
    return this.tabs().find((tab) => tab.holds(hostId, sessionId))
  }

  activeTab(): SessionEditorTab | undefined {
    return this.tabs().find((tab) => tab.active)
  }

  hasSession(): boolean {
    return this.all().some((surface) => surface.session !== undefined)
  }

  // `host:session` keys of the sessions tabs hold, for the sidebar's glyph.
  openMap(): Record<string, 'editor'> {
    const open: Record<string, 'editor'> = {}
    for (const tab of this.#tabs) {
      const session = tab.session
      if (session) {
        open[`${session.host.id}:${session.sessionId}`] = 'editor'
      }
    }
    return open
  }

  add(tab: SessionEditorTab): void {
    this.#tabs.add(tab)
    this.#onDidChange.fire()
  }

  remove(tab: SessionEditorTab): void {
    if (!this.#tabs.delete(tab)) {
      return
    }
    if (this.#focused === tab) {
      this.setFocused(this.panel)
    }
    this.#onDidChange.fire()
  }

  setFocused(surface: AnySurface): void {
    if (this.#focused === surface) {
      return
    }
    this.#focused = surface
    this.#onDidChangeFocus.fire(surface)
  }

  // A surface's session changed under it (the panel took one on or let go): the focused view models re-read.
  changed(): void {
    this.#onDidChange.fire()
  }

  reloadAll(): void {
    for (const surface of this.all()) {
      surface.reloadWebview()
    }
  }

  dispose(): void {
    for (const tab of this.#tabs) {
      tab.dispose()
    }
    this.#tabs.clear()
    this.#onDidChange.dispose()
    this.#onDidChangeFocus.dispose()
  }
}
