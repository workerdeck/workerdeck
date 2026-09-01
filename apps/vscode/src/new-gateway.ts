import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { apiUrl, type HostStore } from './hosts.ts'

export type GatewayFlowDeps = {
  store: HostStore
  refresh: () => Promise<void>
}

type InputOptions = {
  title: string
  prompt: string
  placeHolder?: string
  value?: string
  password?: boolean
  step: number
  totalSteps: number
  validate?: (value: string) => string | undefined
}

const CANCEL = Symbol('cancel')
const BACK = Symbol('back')
type Answer<T> = T | typeof CANCEL | typeof BACK

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
        prompt: 'The server root — /v1 is implied.',
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
    void vscode.window.showErrorMessage(`WorkerDeck: could not save the gateway — ${err instanceof Error ? err.message : String(err)}`)
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

function showInput(options: InputOptions): Promise<Answer<string>> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox()
    input.title = options.title
    input.prompt = options.prompt
    input.placeholder = options.placeHolder
    input.password = options.password ?? false
    input.step = options.step
    input.totalSteps = options.totalSteps
    input.ignoreFocusOut = true
    if (options.step > 1) {
      input.buttons = [vscode.QuickInputButtons.Back]
    }

    let answered = false
    const finish = (answer: Answer<string>) => {
      answered = true
      resolve(answer)
      input.hide()
    }
    input.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish(BACK)
      }
    })
    // `validationMessage` only greys the box out; accepting has to be refused here too.
    input.onDidChangeValue((value) => {
      input.validationMessage = options.validate?.(value)
    })
    input.onDidAccept(() => {
      const problem = options.validate?.(input.value)
      if (problem) {
        input.validationMessage = problem
        return
      }
      finish(input.value)
    })
    // Fires for `esc` and for a real hide alike, so it must not clobber an answer already resolved.
    input.onDidHide(() => {
      if (!answered) {
        resolve(CANCEL)
      }
      input.dispose()
    })
    // After the change handler is registered: assigning `value` fires it, so a prefill that
    // does not validate says so before the first keystroke.
    input.value = options.value ?? ''
    input.show()
  })
}
