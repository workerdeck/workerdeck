import * as vscode from 'vscode'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** What the reloader can refresh in place. */
export type ReloadableView = { reloadWebview: () => void }

/**
 * The dev loop, for an Extension Development Host window (`code
 * --extensionDevelopmentPath=…`, or F5). Watches this extension's own `dist/`
 * while `pnpm --filter workerdeck-vscode dev` rebuilds into it:
 *
 * - a **webview** bundle changed → re-render the webviews in place. Instant, and
 *   the extension host keeps its state (gateways, selection, sockets).
 * - the **extension host** bundle changed → reload the window. VS Code has no
 *   way to swap an extension's code in a live host, so the window is the unit.
 *
 * Off outside development mode: a real install's `dist/` never changes, and a
 * self-triggered window reload is the last thing a user's editor should do.
 */
export function startDevReload(context: vscode.ExtensionContext, views: readonly ReloadableView[]): vscode.Disposable {
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
    // A build writes many files; settle before acting on any of them.
    clearTimeout(timer)
    timer = setTimeout(flush, 400)
  }

  try {
    // Non-recursive, two watchers: `dist/` itself carries the extension bundle,
    // `dist/webview/` the two webview bundles and their CSS.
    watchers.push(watch(dist, (_e, file) => onChange(file, true)))
    watchers.push(watch(join(dist, 'webview'), (_e, file) => onChange(file, false)))
    output.appendLine(`watching ${dist} for rebuilds`)
  } catch (err) {
    // No dist yet (a first run before any build) — not worth failing activation.
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
