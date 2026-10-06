import { createHash } from 'node:crypto'
import type { SessionInfo } from '@workerdeck/protocol'
import * as vscode from 'vscode'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import type { AgentAvatarImage } from './bridge-protocol.ts'

// Keyed by `AgentRef.avatar`, the gateway path, which is stable per agent: the recipe is rolled once and persisted.
export class AgentAvatarCache implements vscode.Disposable {
  readonly #store: HostStore
  readonly #iconDir: vscode.Uri
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly #byPath = new Map<string, AgentAvatarImage>()
  readonly #iconByPath = new Map<string, vscode.Uri>()
  readonly #inFlight = new Set<string>()
  readonly #failed = new Set<string>()

  readonly onDidChange = this.#onDidChange.event

  constructor(store: HostStore, storageUri: vscode.Uri) {
    this.#store = store
    this.#iconDir = vscode.Uri.joinPath(storageUri, 'agent-avatars')
  }

  entries(): Record<string, AgentAvatarImage> {
    return Object.fromEntries(this.#byPath)
  }

  // `iconPath` takes a file, not a data URL, so the still is also written under the extension's global storage.
  iconFor(info: SessionInfo | undefined): vscode.Uri | undefined {
    const key = info?.agent?.avatar
    return key === undefined ? undefined : this.#iconByPath.get(key)
  }

  ensure(sessions: Record<string, SessionInfo[]>): void {
    for (const [hostId, infos] of Object.entries(sessions)) {
      for (const info of infos) {
        const agent = info.agent
        if (!agent?.avatar) {
          continue
        }
        const key = agent.avatar
        if (this.#byPath.has(key) || this.#inFlight.has(key) || this.#failed.has(key)) {
          continue
        }
        this.#inFlight.add(key)
        void this.#fetch(hostId, agent.id, key)
      }
    }
  }

  dispose(): void {
    this.#onDidChange.dispose()
  }

  async #fetch(hostId: string, agentId: string, key: string): Promise<void> {
    try {
      const host = this.#store.get(hostId)
      const client = host ? await clientFor(this.#store, host) : undefined
      if (!client) {
        return
      }
      const still = await client.agentAvatar(agentId)
      const busy = await client.agentAvatar(agentId, true).catch(() => undefined)
      const bytes = new Uint8Array(await still.blob.arrayBuffer())
      const image: AgentAvatarImage = { still: dataUrl(bytes) }
      if (busy?.durations) {
        image.busy = { src: dataUrl(new Uint8Array(await busy.blob.arrayBuffer())), durations: busy.durations }
      }
      this.#byPath.set(key, image)
      await this.#writeIcon(key, bytes)
      this.#onDidChange.fire()
    } catch {
      this.#failed.add(key)
    } finally {
      this.#inFlight.delete(key)
    }
  }

  async #writeIcon(key: string, bytes: Uint8Array): Promise<void> {
    const file = vscode.Uri.joinPath(this.#iconDir, `${createHash('sha1').update(key).digest('hex')}.png`)
    try {
      await vscode.workspace.fs.createDirectory(this.#iconDir)
      await vscode.workspace.fs.writeFile(file, bytes)
      this.#iconByPath.set(key, file)
    } catch {
      this.#iconByPath.delete(key)
    }
  }
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}
