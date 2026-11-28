import { randomBytes } from 'node:crypto'
import { renderSVG } from 'uqr'
import * as vscode from 'vscode'
import { readHostSettings } from './settings.ts'
import { cliError, type HostSupervisor } from './supervisor.ts'

const PAIR_LINK = /^https?:\/\/\S+\/#pair=\S+$/m

async function withProgress<T>(title: string, work: () => Promise<T>): Promise<T> {
  return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, work)
}

// The safe enable sequence of MESH.md 5.1: key and setting first, a restart the user confirms, then the CLI checks
// the live process refuses a keyless request before `tailscale serve` publishes it. With `publicUrl` set, the
// operator's own proxy publishes it and Tailscale is never touched.
export async function enableRemoteAccess(supervisor: HostSupervisor): Promise<void> {
  const settings = readHostSettings()
  if (!settings.enabled) {
    const answer = await vscode.window.showInformationMessage(
      'WorkerDeck: Remote Access publishes the server Host Mode runs on this machine. Turn Host Mode on first.',
      'Enable Host Mode',
    )
    if (answer === 'Enable Host Mode') {
      await vscode.workspace.getConfiguration('workerdeck.host').update('enabled', true, vscode.ConfigurationTarget.Global)
    }
    return
  }

  const proxied = settings.publicUrl !== undefined
  if (!proxied) {
    const check = await withProgress('WorkerDeck: checking Tailscale…', () => supervisor.runCli(['remote', 'status']))
    if (check.code !== 0) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(check)}`)
      return
    }
  }

  if (!settings.remote || supervisor.state.kind !== 'running') {
    const answer = await vscode.window.showInformationMessage(
      'WorkerDeck: Enable Remote Access?',
      {
        modal: true,
        detail:
          (proxied
            ? `The server restarts with its key always required, on loopback for your proxy at ${settings.publicUrl}. `
            : 'The server restarts with its key always required, then tailscale serve publishes it to your tailnet only. ') +
          'Your phone and other computers pair with a link. Closing VS Code keeps turns running.',
      },
      'Enable',
    )
    if (answer !== 'Enable') {
      return
    }
    if (!(await supervisor.switchRemote(true))) {
      return
    }
  }
  if (supervisor.state.kind !== 'running') {
    void vscode.window.showErrorMessage('WorkerDeck: the server did not come back in remote mode; see the server log.')
    return
  }

  if (!proxied) {
    const enabled = await withProgress('WorkerDeck: publishing to your tailnet…', () => supervisor.runCli(['remote', 'enable']))
    if (enabled.code !== 0) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(enabled)}`)
      return
    }
  }
  await showPairingLink(supervisor)
}

export async function disableRemoteAccess(supervisor: HostSupervisor): Promise<void> {
  if (readHostSettings().publicUrl === undefined) {
    const result = await withProgress('WorkerDeck: removing the tailnet route…', () => supervisor.runCli(['remote', 'disable']))
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(`WorkerDeck: ${cliError(result)}`)
      return
    }
  }
  if (readHostSettings().remote && !(await supervisor.switchRemote(false))) {
    void vscode.window.showInformationMessage('WorkerDeck: the tailnet route is gone. The server leaves remote mode on its next restart.')
    return
  }
  void vscode.window.setStatusBarMessage('$(lock) WorkerDeck: remote access off', 3000)
}

let pairingPanel: vscode.WebviewPanel | undefined
let pairingLink: string | undefined

export async function showPairingLink(supervisor: HostSupervisor): Promise<void> {
  const result = await supervisor.runCli(['pair-link', '--no-qr'])
  const link = PAIR_LINK.exec(result.stdout)?.[0]
  if (result.code !== 0 || !link) {
    const answer = await vscode.window.showErrorMessage(
      `WorkerDeck: ${result.code !== 0 ? cliError(result) : 'no pairing link'}`,
      'Enable Remote Access',
    )
    if (answer === 'Enable Remote Access') {
      await enableRemoteAccess(supervisor)
    }
    return
  }
  pairingLink = link
  if (!pairingPanel) {
    const panel = vscode.window.createWebviewPanel('workerdeck.pairing', 'WorkerDeck: Pair a Device', vscode.ViewColumn.Active, {
      enableScripts: true,
    })
    panel.onDidDispose(() => {
      pairingPanel = undefined
    })
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (message === 'copy' && pairingLink) {
        await vscode.env.clipboard.writeText(pairingLink)
        void vscode.window.setStatusBarMessage('$(key) WorkerDeck: pairing link copied', 2000)
      }
    })
    pairingPanel = panel
  }
  pairingPanel.webview.html = pairingHtml(link, randomBytes(16).toString('base64'))
  pairingPanel.reveal()
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function pairingHtml(link: string, nonce: string): string {
  const origin = escapeHtml(link.slice(0, link.indexOf('/#pair=')))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'">
<style>
  body { display: grid; place-items: center; min-height: 90vh; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  .card { text-align: center; max-width: 22rem; }
  .qr { width: 16rem; height: 16rem; margin: 0 auto 1rem; }
  .qr svg { width: 100%; height: 100%; }
  p { color: var(--vscode-descriptionForeground); }
  code { word-break: break-all; }
  button { margin: 0.5rem 0 1rem; padding: 0.4rem 1rem; border: none; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div class="card">
    <div class="qr">${renderSVG(link, { border: 2 })}</div>
    <p>Scan with your phone's camera to open <code>${origin}</code> and sign in.</p>
    <button id="copy">Copy Link</button>
    <p>Anyone with this code or link can run agents on this machine. Show it only to your own devices.</p>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const button = document.getElementById('copy')
    button.addEventListener('click', () => {
      vscode.postMessage('copy')
      button.textContent = 'Copied'
      setTimeout(() => (button.textContent = 'Copy Link'), 1500)
    })
  </script>
</body>
</html>`
}
