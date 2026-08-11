import * as vscode from 'vscode'

/**
 * The HTML skeleton both webviews share. No external `connect-src`: every byte
 * to a gateway rides postMessage. `img-src` allows http(s) for inline images on
 * KEYLESS gateways only — header auth cannot ride an `<img>`, the same trade
 * the iOS client makes.
 */
/**
 * The typeface the AGENT PANEL runs in, from settings. Stamped on `<html>` and
 * read by `styles.css`, rather than pushed over the bridge: it has to be right
 * on the first paint, and a message can't be. A change re-renders the HTML (see
 * `activate`).
 *
 * The panel alone opts in (`{ font: true }`). The sidebar and the section views
 * are ordinary VS Code UI and follow the editor's UI font like every other view
 * — a monospace tree is a monospace tree, not a terminal.
 */
export function fontMode(): 'editor' | 'sans' {
  return vscode.workspace.getConfiguration('workerdeck').get<'editor' | 'sans'>('fontFamily') ===
    'sans'
    ? 'sans'
    : 'editor'
}

/**
 * How much room the transcript gives each message, from settings. Stamped on
 * `<html>` for the same reason the typeface is — the panel reads it as its
 * initial prop, and a first paint at the wrong density is a visible reflow of
 * every row. A change re-renders the HTML (see `activate`).
 *
 * `comfortable` is the default because it is what the Claude Code CLI does, and
 * the panel is trying to read like it.
 */
export function transcriptDensity(): 'comfortable' | 'compact' {
  return vscode.workspace
    .getConfiguration('workerdeck')
    .get<'comfortable' | 'compact'>('transcriptDensity') === 'compact'
    ? 'compact'
    : 'comfortable'
}

export function webviewHtml(
  webview: vscode.Webview,
  dist: vscode.Uri,
  script: string,
  rootAttrs: Record<string, string> = {},
  /** Bumped by the dev reloader: identical HTML would not re-fetch the bundle. */
  version = 0,
  /** `font: true` honours `workerdeck.fontFamily` — the agent panel only. */
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
