import * as vscode from 'vscode'
import { WorkerdeckFileSystem } from './fsp.ts'
import type { ScopeRoot, WorkspaceScope } from './bridge-protocol.ts'

export function workspaceScope(): WorkspaceScope | undefined {
  const folders = vscode.workspace.workspaceFolders ?? []
  const roots: ScopeRoot[] = []
  for (const folder of folders) {
    if (folder.uri.scheme === 'file') {
      roots.push({ path: folder.uri.fsPath })
    } else if (folder.uri.scheme === WorkerdeckFileSystem.scheme) {
      roots.push({ hostId: folder.uri.authority, path: folder.uri.path })
    }
  }
  if (roots.length === 0) {
    return undefined
  }
  const label = vscode.workspace.name ?? folders[0]?.name ?? roots[0]!.path.split('/').pop() ?? 'this project'
  return { label, roots }
}
