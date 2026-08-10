import * as vscode from 'vscode'

/**
 * The HTML skeleton both webviews share. No external `connect-src`: every byte
 * to a gateway rides postMessage. `img-src` allows http(s) for inline images on
 * KEYLESS gateways only — header auth cannot ride an `<img>`, the same trade
 * the iOS client makes.
 */
export function webviewHtml(
  webview: vscode.Webview,
  dist: vscode.Uri,
  script: string,
  rootAttrs: Record<string, string> = {},
  /** Bumped by the dev reloader: identical HTML would not re-fetch the bundle. */
  version = 0,
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
<html lang="en">
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
