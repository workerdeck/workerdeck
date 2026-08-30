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
 *
 * **`cards` only.** The terminal variant draws on a character cell, so it is
 * monospace by construction and takes the editor font through `--cw-font-mono`
 * (see `webview/styles.css`) whatever this says. A proportional face there would
 * not be a preference, it would be a broken grid.
 */
export function fontMode(): 'editor' | 'sans' {
  return vscode.workspace.getConfiguration('workerdeck').get<'editor' | 'sans'>('fontFamily') === 'sans' ? 'sans' : 'editor'
}

/**
 * How much room the transcript gives each message, from settings. Stamped on
 * `<html>` for the same reason the typeface is — the panel reads it as its
 * initial prop, and a first paint at the wrong density is a visible reflow of
 * every row. A change re-renders the HTML (see `activate`).
 *
 * `comfortable` is the default because it is what the Claude Code CLI does, and
 * the panel is trying to read like it.
 *
 * **`cards` only.** A terminal has one line height — that is the premise — so
 * the terminal variant's spacing is a *blank line*, decided per pair of blocks,
 * and there is no density knob to turn. See `ROW_GAP` in `@workerdeck/ui`.
 */
export function transcriptDensity(): 'comfortable' | 'compact' {
  return vscode.workspace.getConfiguration('workerdeck').get<'comfortable' | 'compact'>('transcriptDensity') === 'compact'
    ? 'compact'
    : 'comfortable'
}

/**
 * How the panel draws a turn, from settings. Stamped on `#root` beside the
 * density and for the same reason — the variant decides every row's shape, so a
 * first paint at the wrong one reflows the whole transcript.
 *
 * `terminal` is the default because this is a dock next to a terminal: the
 * theme draws every row on a character cell, which costs the least vertical
 * space and is what the CLI this panel mirrors actually looks like. `cards` is
 * there for a panel dragged out into the editor area, where the chat form has
 * the width it wants.
 *
 * Anything that is not `cards` resolves to `terminal`, which is what quietly
 * carries a settings file still holding the retired `lines` across: someone who
 * chose the no-boxes form keeps a no-boxes form rather than being dropped back
 * into the one they turned off.
 */
export function transcriptVariant(): 'terminal' | 'cards' {
  return vscode.workspace.getConfiguration('workerdeck').get<'terminal' | 'cards'>('transcriptVariant') === 'cards' ? 'cards' : 'terminal'
}

/**
 * The terminal theme's character cell, in **whole pixels**.
 *
 * Follows the editor by default, and that is the point rather than a shortcut:
 * the panel is docked beside the editor and the integrated terminal, and a
 * transcript at a different size from both reads as a web page someone embedded.
 * `workerdeck.terminal.fontSize`/`.lineHeight` override it; `0` (the default)
 * means "whatever the editor is set to".
 *
 * `editor.lineHeight` is three settings in one number — VS Code reads `0` as
 * automatic, anything under 8 as a multiplier of the font size, and the rest as
 * pixels — so the same three readings are made here. Everything is rounded
 * because a fractional cell puts every other row on a half-pixel (see the
 * geometry rules in `@workerdeck/ui`'s `terminal.css`); rounding is not a
 * nicety.
 */
/**
 * The panel-wide base font size, in whole pixels.
 *
 * Priority: `workerdeck.fontSize` → `editor.fontSize` → 13. This is the single
 * knob that drives BOTH the cards variant (through the panel root's `font-size`)
 * and the terminal variant (as the default for the character cell, unless
 * `workerdeck.terminal.fontSize` overrides it). `0` means "follow the editor".
 */
export function panelFontSize(): number {
  const wd = vscode.workspace.getConfiguration('workerdeck')
  const editor = vscode.workspace.getConfiguration('editor')
  return Math.round(wd.get<number>('fontSize') || editor.get<number>('fontSize') || 13)
}

export function terminalMetrics(): { fontSize: number; lineHeight: number } {
  const wd = vscode.workspace.getConfiguration('workerdeck')
  const editor = vscode.workspace.getConfiguration('editor')
  // Terminal-specific → panel-wide → editor → 13.
  const fontSize = wd.get<number>('terminal.fontSize') || panelFontSize()
  const configured = wd.get<number>('terminal.lineHeight') || editor.get<number>('lineHeight') || 0
  // VS Code's own rule, and its own automatic ratio.
  const lineHeight = configured === 0 ? fontSize * 1.5 : configured < 8 ? configured * fontSize : configured
  return { fontSize: Math.round(fontSize), lineHeight: Math.round(lineHeight) }
}

/**
 * The pointer affordances the terminal theme allows itself — the hover fill and
 * the hover-revealed copy. On by default: this is a webview, and refusing what a
 * pointer makes possible would be cosplay. Off is the pure article, for someone
 * who wants the panel to behave exactly like the terminal below it.
 */
export function terminalAffordances(): boolean {
  return vscode.workspace.getConfiguration('workerdeck').get<boolean>('terminal.affordances') !== false
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
