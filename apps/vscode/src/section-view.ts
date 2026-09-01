import type * as vscode from 'vscode'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { HostStore } from './hosts.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import type { HostToSection, SectionToHost, SidebarState } from './bridge-protocol.ts'
import type { SessionVitals } from '@workerdeck/ui'
import { formatCost } from '@workerdeck/ui/format'
import { WebviewHost } from './webview-host.ts'

export type SectionKind = 'info' | 'context' | 'usage' | 'mcp'

export type SectionFeed = {
  state: () => SidebarState
  vitals: () => SessionVitals | undefined
}

export class SectionViewProvider extends WebviewHost<SectionToHost, HostToSection> implements vscode.Disposable {
  readonly #store: HostStore
  readonly #kind: SectionKind
  readonly #feed: SectionFeed
  #transports: WebviewTransportHost | undefined

  protected readonly bundle = 'sections.js'

  constructor(extensionUri: vscode.Uri, store: HostStore, kind: SectionKind, feed: SectionFeed) {
    super(extensionUri)
    this.#store = store
    this.#kind = kind
    this.#feed = feed
  }

  protected override rootAttrs(): Record<string, string> {
    return { 'data-view': this.#kind }
  }

  protected override wire(_view: vscode.WebviewView): void {
    this.resetForReload()
  }

  protected override resetForReload(): void {
    this.#transports?.dispose()
    this.#transports = new WebviewTransportHost(this.#store, (msg) => this.post(msg))
  }

  protected override afterResolve(): void {
    this.push()
  }

  protected override intercept(msg: SectionToHost): Promise<boolean> | boolean {
    return this.#transports?.handle(msg) ?? false
  }

  protected override onReady(): void {
    this.push()
  }

  protected override onMessage(): void {}

  protected override onViewDisposed(): void {
    this.#transports?.dispose()
  }

  push(): void {
    const view = this.view
    if (!view) {
      return
    }
    view.description = headerDescription(this.#kind, this.#feed.state(), this.#feed.vitals())
    if (!this.ready) {
      return
    }
    this.post({
      kind: 'wd-sidebar-state',
      state: this.#feed.state(),
    })
    this.post({
      kind: 'wd-vitals',
      vitals: this.#feed.vitals(),
    })
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}

function headerDescription(kind: SectionKind, state: SidebarState, vitals: SessionVitals | undefined): string | undefined {
  const selected = state.selected
  const info = selected ? state.sessions[selected.hostId]?.find((s) => s.id === selected.sessionId) : undefined
  if (!info) {
    return 'no session'
  }
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
  if (kind === 'usage' && info.totalCostUsd !== undefined) {
    return formatCost(info.totalCostUsd)
  }
  return undefined
}
