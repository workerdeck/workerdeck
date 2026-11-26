import { errorMessage, parsePairingLink } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { apiUrl, type GatewayHost, type HostStore } from './hosts.ts'
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
  // A pasted pairing link carries the key, so the key step is skipped.
  let pairedKey: string | undefined
  let step = 0

  while (step < TOTAL_STEPS) {
    if (step === 0) {
      const picked = await showInput({
        title,
        prompt: 'The server root (/v1 is implied), or a pairing link from Enable Remote Access.',
        placeHolder: 'https://mac-mini.tailnet.ts.net/#pair=…',
        value: baseUrl,
        step: 1,
        totalSteps: TOTAL_STEPS,
        validate: (value) =>
          parsePairingLink(value) || apiUrl({ baseUrl: value.trim() }) ? undefined : 'not a valid gateway URL or pairing link',
      })
      if (picked === CANCEL || picked === BACK) {
        return
      }
      const paired = parsePairingLink(picked)
      baseUrl = paired?.baseUrl ?? picked.trim()
      pairedKey = paired?.key
      const known = await resolveDuplicate(deps, editing?.id, baseUrl, pairedKey)
      if (known === CANCEL) {
        return
      }
      if (known) {
        await save(deps, { ...known, baseUrl }, pairedKey ?? (await deps.store.authKey(known.id)) ?? '')
        return
      }
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
      if (pairedKey !== undefined) {
        await save(deps, { id: editing?.id ?? randomUUID(), name, baseUrl }, pairedKey)
        return
      }
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
      const known = await resolveDuplicate(deps, editing?.id, baseUrl, picked.trim() || undefined)
      if (known === CANCEL) {
        return
      }
      await save(deps, known ? { ...known, baseUrl } : { id: editing?.id ?? randomUUID(), name, baseUrl }, picked.trim())
      return
    }
  }
}

function sameUrl(a: string, b: string): boolean {
  const left = apiUrl({ baseUrl: a })
  return left !== undefined && left.toLowerCase() === apiUrl({ baseUrl: b })?.toLowerCase()
}

// Until gateways carry an id (MESH phase 3) the key is the identity: Host Mode's loopback URL and the tailnet URL of a
// pairing link name the same server, and only the key says so.
async function findDuplicate(deps: GatewayFlowDeps, exceptId: string | undefined, baseUrl: string, key: string | undefined) {
  const others = deps.store.all().filter((h) => h.id !== exceptId)
  for (const host of others) {
    if (sameUrl(host.baseUrl, baseUrl) || (key !== undefined && (await deps.store.authKey(host.id)) === key)) {
      return host
    }
  }
  return undefined
}

async function resolveDuplicate(
  deps: GatewayFlowDeps,
  exceptId: string | undefined,
  baseUrl: string,
  key: string | undefined,
): Promise<GatewayHost | typeof CANCEL | undefined> {
  const host = await findDuplicate(deps, exceptId, baseUrl, key)
  if (!host) {
    return undefined
  }
  if (host.managed) {
    void vscode.window.showInformationMessage(
      `WorkerDeck: this is the server Host Mode runs on this machine, already listed as "${host.name}".`,
    )
    return CANCEL
  }
  const update = 'Update It'
  const answer = await vscode.window.showWarningMessage(
    `WorkerDeck: this gateway is already listed as "${host.name}".`,
    { modal: true, detail: 'Update it to the address and key you entered, or cancel to keep it as it is.' },
    update,
  )
  return answer === update ? host : CANCEL
}

async function save(deps: GatewayFlowDeps, host: { id: string; name: string; baseUrl: string }, authKey: string): Promise<void> {
  try {
    await deps.store.save(host, authKey || undefined)
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not save the gateway - ${errorMessage(err)}`)
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
