import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { apiUrl, type HostStore } from './hosts.ts'
import { BACK, CANCEL, showInput } from './quick-input.ts'

export type GatewayFlowDeps = {
  store: HostStore
  refresh: () => Promise<void>
}

const LOCAL_GATEWAY_URL = 'http://127.0.0.1:8787'
const TOTAL_STEPS = 3

export async function addGateway(deps: GatewayFlowDeps): Promise<void> {
  await run(deps, undefined)
}

export async function editGateway(deps: GatewayFlowDeps, hostId: string): Promise<void> {
  const host = deps.store.get(hostId)
  if (!host) {
    return
  }
  // A managed gateway is Host Mode's own record of the server it runs: settings are the only place it can change.
  if (host.managed) {
    await vscode.commands.executeCommand('workerdeck.host.openSettings')
    return
  }
  // SecretStorage is not reachable from a webview, which is why the key is read here rather than sent to the list.
  await run(deps, { ...host, authKey: (await deps.store.authKey(hostId)) ?? '' })
}

type Editing = { id: string; name: string; baseUrl: string; authKey: string }

async function run(deps: GatewayFlowDeps, editing: Editing | undefined): Promise<void> {
  const title = editing ? `Edit ${editing.name}` : 'Add gateway'
  // The first gateway is nearly always this machine's, so the flow is three `enter`s there too.
  let baseUrl = editing?.baseUrl ?? (deps.store.all().length === 0 ? LOCAL_GATEWAY_URL : '')
  let name = editing?.name ?? ''
  let step = 0

  while (step < TOTAL_STEPS) {
    if (step === 0) {
      const picked = await showInput({
        title,
        prompt: 'The server root - /v1 is implied.',
        placeHolder: 'http://mac-mini.tailnet.ts.net:8787',
        value: baseUrl,
        step: 1,
        totalSteps: TOTAL_STEPS,
        validate: (value) => (apiUrl({ baseUrl: value.trim() }) ? undefined : 'not a valid gateway URL'),
      })
      if (picked === CANCEL || picked === BACK) {
        return
      }
      baseUrl = picked.trim()
      step = 1
    } else if (step === 1) {
      const picked = await showInput({
        title,
        prompt: 'What this gateway is called in the session list.',
        placeHolder: 'mac-mini',
        value: name || suggestName(baseUrl),
        step: 2,
        totalSteps: TOTAL_STEPS,
        validate: (value) => (value.trim() ? undefined : 'name is required'),
      })
      if (picked === CANCEL) {
        return
      }
      if (picked === BACK) {
        step = 0
        continue
      }
      name = picked.trim()
      step = 2
    } else {
      const picked = await showInput({
        title,
        prompt: 'The gateway’s --auth-key. Stored in the OS keychain, never in settings.',
        placeHolder: 'empty for a keyless loopback gateway',
        value: editing?.authKey ?? '',
        password: true,
        step: 3,
        totalSteps: TOTAL_STEPS,
      })
      if (picked === CANCEL) {
        return
      }
      if (picked === BACK) {
        step = 1
        continue
      }
      await save(deps, { id: editing?.id ?? randomUUID(), name, baseUrl }, picked.trim())
      return
    }
  }
}

async function save(deps: GatewayFlowDeps, host: { id: string; name: string; baseUrl: string }, authKey: string): Promise<void> {
  try {
    await deps.store.save(host, authKey || undefined)
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not save the gateway - ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  // The probe runs on the refresh, so the view says connected/unauthorized on its own.
  await vscode.commands.executeCommand('workerdeck.gateways.focus')
  await deps.refresh()
}

function suggestName(baseUrl: string): string {
  try {
    const { hostname } = new URL(baseUrl)
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost' ? 'localhost' : hostname
  } catch {
    return ''
  }
}
