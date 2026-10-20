import * as vscode from 'vscode'
import type { WorkerDeckClient } from '@workerdeck/client'
import { WorkerDeckError } from '@workerdeck/client'
import type { AgentConfig, AgentConfigPatch, AgentInfo } from '@workerdeck/protocol'
import type { HostStore } from './hosts.ts'
import { clientFor } from './gateway.ts'

export type AgentFile = 'settings' | 'brief'

const SETTINGS_SUFFIX = '.agent.json'
const BRIEF_SUFFIX = '.brief.md'
const SETTINGS_KEYS = [
  'cwd',
  'profile',
  'model',
  'reasoningEffort',
  'permissionMode',
  'instructionScope',
  'agentContextReset',
  'sleepAfterMs',
] as const satisfies readonly (keyof AgentConfig)[]

type SettingsKey = (typeof SETTINGS_KEYS)[number]

export type AgentSaved = (saved: { hostId: string; agentId: string; name: string; file: AgentFile }) => void

// The name only labels the tab; the agent id in the path is what is read and written.
export function agentFileUri(hostId: string, agentId: string, name: string, file: AgentFile): vscode.Uri {
  const label = name.replace(/[/\\]/g, '-') || 'agent'
  return vscode.Uri.from({
    scheme: AgentSettingsFileSystem.scheme,
    authority: hostId,
    path: `/${encodeURIComponent(agentId)}/${label}${file === 'settings' ? SETTINGS_SUFFIX : BRIEF_SUFFIX}`,
  })
}

function parseUri(uri: vscode.Uri): { agentId: string; file: AgentFile } {
  const [, agentId, leaf] = uri.path.split('/')
  if (!agentId || !leaf || !(leaf.endsWith(SETTINGS_SUFFIX) || leaf.endsWith(BRIEF_SUFFIX))) {
    throw vscode.FileSystemError.FileNotFound(uri)
  }
  return { agentId: decodeURIComponent(agentId), file: leaf.endsWith(SETTINGS_SUFFIX) ? 'settings' : 'brief' }
}

export function settingsText(config: AgentConfig): string {
  const shown: Partial<Record<SettingsKey, unknown>> = {}
  for (const key of SETTINGS_KEYS) {
    if (config[key] !== undefined) {
      shown[key] = config[key]
    }
  }
  return `${JSON.stringify(shown, null, 2)}\n`
}

// Every settings key the edit dropped is sent as `null`, which clears it back to its default on the gateway.
export function settingsPatch(current: AgentConfig, text: string): AgentConfigPatch {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`not valid JSON (${err instanceof Error ? err.message : String(err)})`, { cause: err })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the settings must be a JSON object')
  }
  const edited = parsed as Record<string, unknown>
  if ('brief' in edited) {
    throw new Error('the brief is edited on its own: use Edit brief in the agent menu')
  }
  const unknown = Object.keys(edited).filter((key) => !(SETTINGS_KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw new Error(`unknown setting${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')} (known: ${SETTINGS_KEYS.join(', ')})`)
  }
  const patch: Record<string, unknown> = {}
  for (const key of SETTINGS_KEYS) {
    if (key in edited) {
      patch[key] = edited[key]
    } else if (current[key] !== undefined) {
      patch[key] = null
    }
  }
  return patch as AgentConfigPatch
}

export class AgentSettingsFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  static readonly scheme = 'workerdeck-agent'

  readonly #store: HostStore
  readonly #onSaved: AgentSaved
  readonly #emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.#emitter.event
  readonly #mtimes = new Map<string, number>()

  constructor(store: HostStore, onSaved: AgentSaved) {
    this.#store = store
    this.#onSaved = onSaved
  }

  async #client(uri: vscode.Uri): Promise<WorkerDeckClient> {
    const host = this.#store.get(uri.authority)
    const client = host && (await clientFor(this.#store, host))
    if (!client) {
      throw vscode.FileSystemError.Unavailable(`unknown workerdeck gateway: ${uri.authority}`)
    }
    return client
  }

  async #agent(uri: vscode.Uri, client: WorkerDeckClient, agentId: string): Promise<AgentInfo> {
    try {
      return (await client.getAgent(agentId)).agent
    } catch (err) {
      if (err instanceof WorkerDeckError && err.status === 404) {
        throw vscode.FileSystemError.FileNotFound(uri)
      }
      throw err
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    parseUri(uri)
    const key = uri.toString()
    const mtime = this.#mtimes.get(key) ?? Date.now()
    this.#mtimes.set(key, mtime)
    return { type: vscode.FileType.File, ctime: 0, mtime, size: 0 }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { agentId, file } = parseUri(uri)
    const agent = await this.#agent(uri, await this.#client(uri), agentId)
    return new TextEncoder().encode(file === 'settings' ? settingsText(agent.config) : (agent.config.brief ?? ''))
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { agentId, file } = parseUri(uri)
    const client = await this.#client(uri)
    const text = new TextDecoder().decode(content)
    const agent = await this.#agent(uri, client, agentId)
    let config: AgentConfigPatch
    try {
      config = file === 'settings' ? settingsPatch(agent.config, text) : { brief: text.trim() || null }
    } catch (err) {
      throw vscode.FileSystemError.NoPermissions(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await client.updateAgent(agentId, { config })
    } catch (err) {
      throw vscode.FileSystemError.NoPermissions(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.#mtimes.set(uri.toString(), Date.now())
    this.#emitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
    this.#onSaved({ hostId: uri.authority, agentId, name: agent.name, file })
  }

  readDirectory(): [string, vscode.FileType][] {
    return []
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  dispose(): void {
    this.#emitter.dispose()
  }
}
