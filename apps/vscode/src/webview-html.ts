/**
 * The HTML skeleton every webview shares, plus the settings readings that have to
 * be stamped into it. No external `connect-src`: every byte to a gateway rides
 * postMessage. `img-src` allows http(s) for inline images on KEYLESS gateways only
 * — header auth cannot ride an `<img>`, the same trade the iOS client makes.
 *
 * Everything below is stamped on `<html>`/`#root` rather than pushed over the
 * bridge, because it has to be right on the *first* paint and a message cannot be.
 * A change to any of them re-renders the HTML (see `activate`).
 */

import * as vscode from 'vscode'

/**
 * The typeface the agent panel runs in. The panel alone opts in (`{ font: true }`);
 * the sidebar and section views are ordinary VS Code UI and follow the editor's UI
 * font. **`cards` only** — the terminal variant is monospace by construction and
 * takes the editor font through `--cw-font-mono`.
 */
export const fontMode = (): 'editor' | 'sans' => {
  return vscode.workspace.getConfiguration('workerdeck').get<'editor' | 'sans'>('fontFamily') === 'sans' ? 'sans' : 'editor'
}

/**
 * How much room the transcript gives each message. **`cards` only** — a terminal
 * has one line height, so the terminal variant's spacing is a blank line decided
 * per pair of blocks (see `ROW_GAP` in `@workerdeck/ui`).
 */
export const transcriptDensity = (): 'comfortable' | 'compact' => {
  return vscode.workspace.getConfiguration('workerdeck').get<'comfortable' | 'compact'>('transcriptDensity') === 'compact'
    ? 'compact'
    : 'comfortable'
}

/**
 * How the panel draws a turn. Anything that is not `cards` resolves to `terminal`,
 * which is what carries a settings file still holding the retired `lines` across.
 */
export const transcriptVariant = (): 'terminal' | 'cards' => {
  return vscode.workspace.getConfiguration('workerdeck').get<'terminal' | 'cards'>('transcriptVariant') === 'cards' ? 'cards' : 'terminal'
}

/**
 * The panel-wide base font size, in whole pixels: `workerdeck.fontSize` →
 * `editor.fontSize` → 13. The one knob behind both variants — the cards root's
 * `font-size`, and the terminal cell's default size.
 */
export const panelFontSize = (): number => {
  const wd = vscode.workspace.getConfiguration('workerdeck')
  const editor = vscode.workspace.getConfiguration('editor')
  return Math.round(wd.get<number>('fontSize') || editor.get<number>('fontSize') || 13)
}

/**
 * The terminal theme's character cell, in **whole pixels**. `editor.lineHeight` is
 * three settings in one number — VS Code reads `0` as automatic, anything under 8
 * as a multiplier of the font size, the rest as pixels — so the same three
 * readings are made here. Rounding is not a nicety: a fractional cell puts every
 * other row on a half-pixel (see `terminal.css`'s geometry rules).
 */
export const terminalMetrics = (): { fontSize: number; lineHeight: number } => {
  const wd = vscode.workspace.getConfiguration('workerdeck')
  const editor = vscode.workspace.getConfiguration('editor')
  // Terminal-specific → panel-wide → editor → 13.
  const fontSize = wd.get<number>('terminal.fontSize') || panelFontSize()
  const configured = wd.get<number>('terminal.lineHeight') || editor.get<number>('lineHeight') || 0
  // VS Code's own rule, and its own automatic ratio.
  const lineHeight = configured === 0 ? fontSize * 1.5 : configured < 8 ? configured * fontSize : configured
  return { fontSize: Math.round(fontSize), lineHeight: Math.round(lineHeight) }
}

/** The pointer affordances the terminal theme allows itself: the hover fill and the
 * hover-revealed copy. Off is the pure article. */
export const terminalAffordances = (): boolean => {
  return vscode.workspace.getConfiguration('workerdeck').get<boolean>('terminal.affordances') !== false
}

export const webviewHtml = (
  webview: vscode.Webview,
  dist: vscode.Uri,
  script: string,
  rootAttrs: Record<string, string> = {},
  /** Bumped by the dev reloader: identical HTML would not re-fetch the bundle. */
  version = 0,
  /** `font: true` honours `workerdeck.fontFamily` — the agent panel only. */
  options: { font?: boolean } = {},
): string => {
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
