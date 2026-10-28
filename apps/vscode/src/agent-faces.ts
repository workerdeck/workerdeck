import { createHash } from 'node:crypto'
import { sessionState, type SessionInfo, type SessionRow } from '@workerdeck/protocol'
import { faceProjectOf, faceSvg } from '@workerdeck/ui/format'
import * as vscode from 'vscode'

export type FaceIcon = { light: vscode.Uri; dark: vscode.Uri }

// An editor tab's `iconPath` takes files, not markup, so each face is written once per theme under global storage.
export class AgentFaceIcons implements vscode.Disposable {
  readonly #dir: vscode.Uri
  readonly #icons = new Map<string, FaceIcon>()
  readonly #writing = new Set<string>()
  readonly #onDidChange = new vscode.EventEmitter<void>()

  readonly onDidChange = this.#onDidChange.event

  constructor(storageUri: vscode.Uri) {
    this.#dir = vscode.Uri.joinPath(storageUri, 'agent-faces')
  }

  iconFor(info: SessionInfo | undefined): FaceIcon | undefined {
    const face = info?.agent?.face
    if (!info || !face) {
      return undefined
    }
    const project = faceProjectOf(info)
    const key = createHash('sha1').update(JSON.stringify([face, project])).digest('hex').slice(0, 16)
    const held = this.#icons.get(key)
    if (!held && !this.#writing.has(key)) {
      this.#writing.add(key)
      void this.#write(key, (theme) => faceSvg({ face, project, size: 32, id: `f${key}`, theme }))
    }
    return held
  }

  async #write(key: string, draw: (theme: 'light' | 'dark') => string): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.#dir)
      const icon = { light: vscode.Uri.joinPath(this.#dir, `${key}-light.svg`), dark: vscode.Uri.joinPath(this.#dir, `${key}-dark.svg`) }
      const svg = (theme: 'light' | 'dark') => new TextEncoder().encode(draw(theme).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))
      await vscode.workspace.fs.writeFile(icon.light, svg('light'))
      await vscode.workspace.fs.writeFile(icon.dark, svg('dark'))
      this.#icons.set(key, icon)
      this.#onDidChange.fire()
    } catch {
      this.#icons.delete(key)
    } finally {
      this.#writing.delete(key)
    }
  }

  dispose(): void {
    this.#onDidChange.dispose()
  }
}

// What a session panel's `#` rows draw their faces from: the host's sessions as rows, keyed by session id.
export function peerRowsOf(hostId: string, sessions: readonly SessionInfo[]): Record<string, SessionRow> {
  return Object.fromEntries(
    sessions.map((info) => [
      info.id,
      { hostId, hostName: '', local: false, adapter: info.engine ?? 'claude', state: sessionState(info), info, unseen: 0 },
    ]),
  )
}
