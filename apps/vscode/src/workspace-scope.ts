import * as vscode from 'vscode'
import { WorkerdeckFileSystem } from './fsp.ts'
import type { ScopeRoot, WorkspaceScope } from './bridge-protocol.ts'

/**
 * What "this project" means in this window: the open folders, each tagged with
 * the gateway whose sessions could be inside it.
 *
 * A `file:` folder is a path on the machine the extension host runs on, so it
 * scopes loopback gateways only (`hostId` absent → any local host) — the same
 * local-vs-remote call `cwdSuggestion` makes, decided from the gateway URL and
 * never by probing paths. A `workerdeck://<hostId>/…` mount scopes exactly that
 * gateway. Anything else (untitled, virtual FS from another extension) has no
 * meaning as a session cwd and is dropped.
 */
export function workspaceScope(): WorkspaceScope | undefined {
  const folders = vscode.workspace.workspaceFolders ?? []
  const roots: ScopeRoot[] = []
  for (const folder of folders) {
    if (folder.uri.scheme === 'file') roots.push({ path: folder.uri.fsPath })
    else if (folder.uri.scheme === WorkerdeckFileSystem.scheme) {
      roots.push({ hostId: folder.uri.authority, path: folder.uri.path })
    }
  }
  if (roots.length === 0) return undefined
  const label =
    vscode.workspace.name ?? folders[0]?.name ?? roots[0]!.path.split('/').pop() ?? 'this project'
  return { label, roots }
}
