import * as vscode from 'vscode'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export type ReloadableView = { reloadWebview: () => void }

export const startDevReload = (context: vscode.ExtensionContext, views: readonly ReloadableView[]): vscode.Disposable => {
  const enabled =
    context.extensionMode === vscode.ExtensionMode.Development &&
    vscode.workspace.getConfiguration('workerdeck').get<boolean>('dev.autoReload', true)
  if (!enabled || context.extensionUri.scheme !== 'file') {
    return new vscode.Disposable(() => {})
  }

  const dist = join(context.extensionUri.fsPath, 'dist')
  const output = vscode.window.createOutputChannel('WorkerDeck Dev')
  let timer: NodeJS.Timeout | undefined
  let pendingHostReload = false
  const watchers: FSWatcher[] = []

  const flush = () => {
    timer = undefined
    if (pendingHostReload) {
      pendingHostReload = false
      output.appendLine('extension bundle changed — reloading the window')
      void vscode.commands.executeCommand('workbench.action.reloadWindow')
      return
    }
    output.appendLine('webview bundle changed — re-rendering webviews')
    for (const view of views) {
      view.reloadWebview()
    }
  }

  const onChange = (file: string | null, hostSide: boolean) => {
    if (!file) {
      return
    }
    if (!/\.(js|cjs|css)$/.test(file)) {
      return
    }
    pendingHostReload ||= hostSide
    clearTimeout(timer)
    timer = setTimeout(flush, 400)
  }

  try {
    // Non-recursive: `dist/` carries the extension bundle, `dist/webview/` the webview bundles.
    watchers.push(watch(dist, (_e, file) => onChange(file, true)))
    watchers.push(watch(join(dist, 'webview'), (_e, file) => onChange(file, false)))
    output.appendLine(`watching ${dist} for rebuilds`)
  } catch (err) {
    output.appendLine(`dev reload off: ${err instanceof Error ? err.message : String(err)}`)
  }

  return new vscode.Disposable(() => {
    clearTimeout(timer)
    for (const watcher of watchers) {
      watcher.close()
    }
    output.dispose()
  })
}
