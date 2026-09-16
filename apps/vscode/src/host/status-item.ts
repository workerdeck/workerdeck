import * as vscode from 'vscode'
import type { HostState } from './supervisor.ts'
import { readHostSettings } from './settings.ts'

export class HostStatusItem implements vscode.Disposable {
  readonly #item: vscode.StatusBarItem
  #state: HostState = { kind: 'disabled' }

  constructor() {
    // 53 — above the subagent and unread badges: this one is about the machine, not any session.
    this.#item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 53)
    this.#item.command = 'workerdeck.host.actions'
  }

  update(state: HostState): void {
    this.#state = state
    this.render()
  }

  render(): void {
    const state = this.#state
    if (state.kind === 'disabled' || !readHostSettings().statusBar) {
      this.#item.hide()
      return
    }
    const tip = new vscode.MarkdownString()
    tip.appendMarkdown('**WorkerDeck Host Mode**\n\n')
    switch (state.kind) {
      case 'stopped': {
        this.#item.text = '$(server) off'
        tip.appendMarkdown('The server is not running.')
        break
      }
      case 'starting': {
        this.#item.text = '$(sync~spin) starting'
        tip.appendMarkdown('Starting the server…')
        break
      }
      case 'stopping': {
        this.#item.text = '$(sync~spin) stopping'
        tip.appendMarkdown('Letting turns in flight finish…')
        break
      }
      case 'running': {
        const port = new URL(state.url).port
        this.#item.text = `$(server-process) :${port}`
        tip.appendMarkdown(`Serving [${state.url}](${state.url})\n\n`)
        tip.appendMarkdown(
          state.owned ? `Started by VS Code (pid ${state.pid ?? '?'}).` : 'Started outside VS Code — this window will not stop it.',
        )
        break
      }
      case 'error': {
        this.#item.text = '$(server) $(warning)'
        tip.appendMarkdown(state.message)
        break
      }
    }
    tip.appendMarkdown('\n\nClick for start, stop and restart.')
    this.#item.tooltip = tip
    this.#item.backgroundColor = state.kind === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    this.#item.color = state.kind === 'running' ? new vscode.ThemeColor('charts.blue') : undefined
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
          { label: '$(globe) Open Dashboard in Browser', description: state.url, command: 'workerdeck.host.openDashboard' },
        ]
      : [{ label: '$(play) Start Server', command: 'workerdeck.host.start' }]),
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
