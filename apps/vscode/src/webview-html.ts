import * as vscode from 'vscode'

export function fontMode(): 'editor' | 'sans' {
  return vscode.workspace.getConfiguration('workerdeck').get<'editor' | 'sans'>('fontFamily') === 'sans' ? 'sans' : 'editor'
}

export function transcriptDensity(): 'comfortable' | 'compact' {
  return vscode.workspace.getConfiguration('workerdeck').get<'comfortable' | 'compact'>('transcriptDensity') === 'compact'
    ? 'compact'
    : 'comfortable'
}

export function transcriptVariant(): 'terminal' | 'cards' {
  // Anything not `cards` resolves to `terminal`, which is what carries a settings file still holding the retired `lines` value.
  return vscode.workspace.getConfiguration('workerdeck').get<'terminal' | 'cards'>('transcriptVariant') === 'cards' ? 'cards' : 'terminal'
}

export function panelFontSize(): number {
  const wd = vscode.workspace.getConfiguration('workerdeck')
  const editor = vscode.workspace.getConfiguration('editor')
  return Math.round(wd.get<number>('fontSize') || editor.get<number>('fontSize') || 13)
}

export function terminalMetrics(): { fontSize: number; lineHeight: number } {
  const wd = vscode.workspace.getConfiguration('workerdeck')
  const editor = vscode.workspace.getConfiguration('editor')
  const fontSize = wd.get<number>('terminal.fontSize') || panelFontSize()
  const configured = wd.get<number>('terminal.lineHeight') || editor.get<number>('lineHeight') || 0
  const lineHeight = configured === 0 ? fontSize * 1.5 : configured < 8 ? configured * fontSize : configured
  return { fontSize: Math.round(fontSize), lineHeight: Math.round(lineHeight) }
}

export function terminalAffordances(): boolean {
  return vscode.workspace.getConfiguration('workerdeck').get<boolean>('terminal.affordances') !== false
}

export function webviewHtml(
  webview: vscode.Webview,
  dist: vscode.Uri,
  script: string,
  rootAttrs: Record<string, string> = {},
  // Bumped by the dev reloader: identical HTML would not re-fetch the bundle.
  version = 0,
  options: { font?: boolean } = {},
): string {
  const bust = version ? `?v=${version}` : ''
  const scriptUri = `${webview.asWebviewUri(vscode.Uri.joinPath(dist, script))}${bust}`
  const attrs = Object.entries(rootAttrs)
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`)
    .join('')
  const style = `${webview.asWebviewUri(vscode.Uri.joinPath(dist, 'main.css'))}${bust}`
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    // http(s) is for inline images served by a KEYLESS gateway — header auth cannot ride an `<img>`.
    `img-src ${webview.cspSource} data: blob: http: https:`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="en"${options.font ? ` data-font="${fontMode()}"` : ''}>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="root"${attrs}></div>
<script type="module" src="${scriptUri}"></script>
</body>
</html>`
}
