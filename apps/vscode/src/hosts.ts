import * as vscode from 'vscode'
export { apiUrl, isLoopbackHost } from './host-url.ts'

/**
 * A workerdeck gateway this window can drive — the iOS `Host` model, ported.
 *
 * `baseUrl` is stored exactly as the user typed it; `apiUrl()` appends the
 * `/v1` prefix so nobody has to remember it. Names and URLs live in
 * `globalState`; the auth key lives in `SecretStorage` (the OS keychain),
 * keyed by host id, and is deleted with the host.
 */
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

  /**
   * The gateways the operator configured — nothing more. There is no implicit
   * localhost entry: an unconfigured install shows an empty list with an "add
   * gateway" affordance (prefilled with the loopback URL), rather than a phantom
   * gateway that is usually unreachable.
   */
  all(): GatewayHost[] {
    return this.#state.get<GatewayHost[]>(HOSTS_KEY, [])
  }

  get(id: string): GatewayHost | undefined {
    return this.all().find((h) => h.id === id)
  }

  async save(host: GatewayHost, authKey: string | undefined): Promise<void> {
    const stored = this.#state.get<GatewayHost[]>(HOSTS_KEY, [])
    const next = stored.some((h) => h.id === host.id)
      ? stored.map((h) => (h.id === host.id ? host : h))
      : [...stored, host]
    await this.#state.update(HOSTS_KEY, next)
    // Empty string means "unauthenticated gateway" and clears any stored key.
    if (authKey) await this.#secrets.store(secretKey(host.id), authKey)
    else await this.#secrets.delete(secretKey(host.id))
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

  /** The auth key, or undefined for keyless (loopback) gateways. */
  async authKey(id: string): Promise<string | undefined> {
    return (await this.#secrets.get(secretKey(id))) || undefined
  }

  /**
   * Auth headers for REST/WS against this host. The single place the
   * `Authorization: Bearer` transport is spelled — the same one secret the CLI
   * accepts over its header transport.
   */
  async authHeaders(id: string): Promise<Record<string, string>> {
    const key = await this.authKey(id)
    return key ? { authorization: `Bearer ${key}` } : {}
  }
}
