import * as vscode from 'vscode'
import type { HostState } from './supervisor.ts'
import { readHostSettings } from './settings.ts'

export type GatewayRow = { name: string; probe: 'connected' | 'unauthorized' | 'unreachable' | 'pending' }

const PROBE_LABEL: Record<GatewayRow['probe'], string> = {
  connected: 'connected',
  unauthorized: 'not authorized',
  unreachable: 'unreachable',
  pending: 'checking…',
}

export class HostStatusItem implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem
  readonly #rows: () => GatewayRow[]
  #state: HostState = { kind: 'disabled' }

  constructor(rows: () => GatewayRow[]) {
    // 53 - above the subagent and unread badges: this one is about the machine, not any session.
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 53)
    this.#item.command = 'workerdeck.host.actions'
    this.#rows = rows
  }

  update(state: HostState): void {
    this.#state = state
    this.render()
  }

  render(): void {
    const state = this.#state
    const rows = this.#rows()
    if (!readHostSettings().statusBar || (state.kind === 'disabled' && rows.length === 0)) {
      this.#item.hide()
      return
    }
    const tip = new vscode.MarkdownString()
    // A transient Host Mode state outranks the count: it is short-lived, it is the thing the click
    // acts on, and a count cannot say "starting". The count is what the steady state has to show,
    // because "running" is true almost always and tells you nothing you did not already know.
    if (state.kind === 'starting' || state.kind === 'stopping' || state.kind === 'error') {
      tip.appendMarkdown('**WorkerDeck Host Mode**\n\n')
      if (state.kind === 'error') {
        this.#item.text = '$(server) $(warning)'
        tip.appendMarkdown(state.message)
      } else {
        this.#item.text = `$(sync~spin) ${state.kind}`
        tip.appendMarkdown(state.kind === 'starting' ? 'Starting the server…' : 'Letting turns in flight finish…')
      }
      this.#item.backgroundColor = state.kind === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
      this.#item.color = undefined
      tip.appendMarkdown('\n\nClick for start, stop and restart.')
      this.#item.tooltip = tip
      this.#item.show()
      return
    }
    const connected = rows.filter((row) => row.probe === 'connected').length
    this.#item.text = `$(server-process) ${connected}/${rows.length}`
    this.#item.backgroundColor = connected < rows.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    this.#item.color = connected === rows.length && rows.length > 0 ? new vscode.ThemeColor('charts.blue') : undefined
    tip.appendMarkdown(`**${connected} of ${rows.length} gateway${rows.length === 1 ? '' : 's'} connected**\n\n`)
    for (const row of rows) {
      tip.appendMarkdown(`- ${row.name} - ${PROBE_LABEL[row.probe]}\n`)
    }
    tip.appendMarkdown('\n**Host Mode** - ')
    if (state.kind === 'running') {
      tip.appendMarkdown(`serving [${state.url}](${state.url})\n\n`)
      tip.appendMarkdown(
        state.owned ? `Started by VS Code (pid ${state.pid ?? '?'}).` : 'Started outside VS Code - this window will not stop it.',
      )
    } else {
      tip.appendMarkdown(state.kind === 'disabled' ? 'off for this window.' : 'the server is not running.')
    }
    tip.appendMarkdown('\n\nClick for start, stop and the gateway list.')
    this.#item.tooltip = tip
    this.#item.show()
  }

  dispose(): void {
    this.#item.dispose()
  }
}

export async function hostActions(state: HostState): Promise<void> {
  const running = state.kind === 'running'
  const items: { label: string; description?: string; command: string }[] = [
    ...(running
      ? [
          { label: '$(debug-stop) Stop Server', command: 'workerdeck.host.stop' },
          { label: '$(debug-restart) Restart Server', command: 'workerdeck.host.restart' },
          ...(readHostSettings().hotReload ? [{ label: '$(sync) Hot-Reload Server', command: 'workerdeck.host.reload' }] : []),
          { label: '$(globe) Open Dashboard in Browser', description: state.url, command: 'workerdeck.host.openDashboard' },
        ]
      : [{ label: '$(play) Start Server', command: 'workerdeck.host.start' }]),
    // The badge counts every gateway, not just this machine's, so its menu has to reach them.
    { label: '$(server) Gateways', command: 'workerdeck.gateways.focus' },
    { label: '$(output) Show Server Log', command: 'workerdeck.host.showLog' },
    { label: '$(gear) Host Mode Settings', command: 'workerdeck.host.openSettings' },
  ]
  const picked = await vscode.window.showQuickPick(items, {
    title: 'WorkerDeck: Host Mode',
    placeHolder: state.kind === 'error' ? state.message : undefined,
  })
  if (picked) {
    await vscode.commands.executeCommand(picked.command)
  }
}
