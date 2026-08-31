import * as vscode from 'vscode'
export { apiUrl, isLoopbackHost } from '@workerdeck/client'

export type GatewayHost = {
  id: string
  name: string
  baseUrl: string
}

const HOSTS_KEY = 'workerdeck.hosts'
const secretKey = (id: string) => `workerdeck.host.${id}.authKey`

export class HostStore {
  readonly #state: vscode.Memento
  readonly #secrets: vscode.SecretStorage
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#onDidChange.event

  constructor(context: vscode.ExtensionContext) {
    this.#state = context.globalState
    this.#secrets = context.secrets
  }

  all(): GatewayHost[] {
    return this.#state.get<GatewayHost[]>(HOSTS_KEY, [])
  }

  get(id: string): GatewayHost | undefined {
    return this.all().find((h) => h.id === id)
  }

  async save(host: GatewayHost, authKey: string | undefined): Promise<void> {
    const stored = this.#state.get<GatewayHost[]>(HOSTS_KEY, [])
    const next = stored.some((h) => h.id === host.id) ? stored.map((h) => (h.id === host.id ? host : h)) : [...stored, host]
    await this.#state.update(HOSTS_KEY, next)
    // Empty string means "unauthenticated gateway" and clears any stored key.
    if (authKey) {
      await this.#secrets.store(secretKey(host.id), authKey)
    } else {
      await this.#secrets.delete(secretKey(host.id))
    }
    this.#onDidChange.fire()
  }

  async remove(id: string): Promise<void> {
    const stored = this.#state.get<GatewayHost[]>(HOSTS_KEY, [])
    await this.#state.update(
      HOSTS_KEY,
      stored.filter((h) => h.id !== id),
    )
    await this.#secrets.delete(secretKey(id))
    this.#onDidChange.fire()
  }

  async authKey(id: string): Promise<string | undefined> {
    return (await this.#secrets.get(secretKey(id))) || undefined
  }

  async authHeaders(id: string): Promise<Record<string, string>> {
    const key = await this.authKey(id)
    return key ? { authorization: `Bearer ${key}` } : {}
  }
}
