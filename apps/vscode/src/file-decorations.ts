import * as vscode from 'vscode'
import type { WireDecoration } from './bridge-protocol.ts'

type GitChange = { uri: vscode.Uri; status: number }

type GitRepository = {
  rootUri: vscode.Uri
  state: {
    workingTreeChanges: GitChange[]
    indexChanges: GitChange[]
    untrackedChanges?: GitChange[]
    mergeChanges: GitChange[]
    onDidChange: vscode.Event<void>
  }
}

type GitApi = {
  repositories: GitRepository[]
  onDidOpenRepository: vscode.Event<GitRepository>
  onDidCloseRepository: vscode.Event<GitRepository>
}

type GitStatusStyle = { letter: string; color: string; tooltip: string; faded?: boolean }

// The git extension's Status enum, and the theme colours its own FileDecorationProvider paints with.
const GIT_STATUS: Record<number, GitStatusStyle> = {
  0: { letter: 'M', color: 'gitDecoration-stageModifiedResourceForeground', tooltip: 'Index Modified' },
  1: { letter: 'A', color: 'gitDecoration-addedResourceForeground', tooltip: 'Index Added' },
  2: { letter: 'D', color: 'gitDecoration-stageDeletedResourceForeground', tooltip: 'Index Deleted' },
  3: { letter: 'R', color: 'gitDecoration-renamedResourceForeground', tooltip: 'Index Renamed' },
  4: { letter: 'C', color: 'gitDecoration-renamedResourceForeground', tooltip: 'Index Copied' },
  5: { letter: 'M', color: 'gitDecoration-modifiedResourceForeground', tooltip: 'Modified' },
  6: { letter: 'D', color: 'gitDecoration-deletedResourceForeground', tooltip: 'Deleted' },
  7: { letter: 'U', color: 'gitDecoration-untrackedResourceForeground', tooltip: 'Untracked' },
  8: { letter: 'I', color: 'gitDecoration-ignoredResourceForeground', tooltip: 'Ignored', faded: true },
  9: { letter: 'A', color: 'gitDecoration-addedResourceForeground', tooltip: 'Intent to Add' },
  10: { letter: 'R', color: 'gitDecoration-renamedResourceForeground', tooltip: 'Intent to Rename' },
  11: { letter: 'T', color: 'gitDecoration-modifiedResourceForeground', tooltip: 'Type Changed' },
}
const CONFLICT: GitStatusStyle = { letter: '!', color: 'gitDecoration-conflictingResourceForeground', tooltip: 'Conflict' }
const PUSH_DEBOUNCE_MS = 200

export class FileDecorations implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>()
  readonly onDidChange = this.#changed.event
  readonly #disposables: vscode.Disposable[] = [this.#changed]
  readonly #repoListeners = new Map<GitRepository, vscode.Disposable>()
  #git: GitApi | undefined
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    this.#disposables.push(vscode.languages.onDidChangeDiagnostics(() => this.#fire()))
    void this.#connectGit()
  }

  async #connectGit(): Promise<void> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git')
    if (!extension) {
      return
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate()
      this.#git = exports.getAPI(1)
    } catch {
      return
    }
    for (const repo of this.#git.repositories) {
      this.#watch(repo)
    }
    this.#disposables.push(
      this.#git.onDidOpenRepository((repo) => this.#watch(repo)),
      this.#git.onDidCloseRepository((repo) => {
        this.#repoListeners.get(repo)?.dispose()
        this.#repoListeners.delete(repo)
        this.#fire()
      }),
    )
    this.#fire()
  }

  #watch(repo: GitRepository): void {
    if (!this.#repoListeners.has(repo)) {
      this.#repoListeners.set(
        repo,
        repo.state.onDidChange(() => this.#fire()),
      )
      this.#fire()
    }
  }

  #fire(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#changed.fire(), PUSH_DEBOUNCE_MS)
  }

  // Folders inherit the colour of what they contain, never a letter: the Explorer's bubbling rule.
  under(root: vscode.Uri): Record<string, WireDecoration> {
    const files = new Map<string, { git?: GitStatusStyle; errors: number; warnings: number }>()
    const entry = (uri: vscode.Uri) => {
      const key = uri.toString()
      let found = files.get(key)
      if (!found) {
        found = { errors: 0, warnings: 0 }
        files.set(key, found)
      }
      return found
    }
    if (root.scheme === 'file') {
      for (const repo of this.#git?.repositories ?? []) {
        const { indexChanges, workingTreeChanges, untrackedChanges = [], mergeChanges } = repo.state
        for (const change of [...indexChanges, ...workingTreeChanges, ...untrackedChanges]) {
          if (within(root, change.uri)) {
            entry(change.uri).git = GIT_STATUS[change.status] ?? entry(change.uri).git
          }
        }
        for (const change of mergeChanges) {
          if (within(root, change.uri)) {
            entry(change.uri).git = CONFLICT
          }
        }
      }
    }
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (!within(root, uri)) {
        continue
      }
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
          entry(uri).errors++
        } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
          entry(uri).warnings++
        }
      }
    }
    const out: Record<string, WireDecoration> = {}
    const folders = new Map<string, { color: string; rank: number }>()
    for (const [key, found] of files) {
      const problems = found.errors || found.warnings
      const problemColor = found.errors ? 'list-errorForeground' : found.warnings ? 'list-warningForeground' : undefined
      const color = problemColor ?? found.git?.color
      const badge = [problems ? String(problems) : undefined, found.git?.letter].filter(Boolean).join(', ')
      const tooltip = [
        found.errors ? `${found.errors} problem${found.errors === 1 ? '' : 's'} in this file` : undefined,
        found.git?.tooltip,
      ]
        .filter(Boolean)
        .join(', ')
      out[key] = { color, badge: badge || undefined, tooltip: tooltip || undefined, faded: found.git?.faded }
      if (color && !found.git?.faded) {
        const rank = found.errors ? 3 : found.warnings ? 2 : 1
        let dir = vscode.Uri.parse(key)
        while (within(root, dir) && dir.path !== root.path) {
          dir = vscode.Uri.joinPath(dir, '..')
          const current = folders.get(dir.toString())
          if (!current || current.rank < rank) {
            folders.set(dir.toString(), { color, rank })
          }
        }
      }
    }
    for (const [key, { color }] of folders) {
      out[key] = { ...out[key], color: out[key]?.color ?? color }
    }
    return out
  }

  dispose(): void {
    clearTimeout(this.#timer)
    for (const listener of this.#repoListeners.values()) {
      listener.dispose()
    }
    for (const disposable of this.#disposables) {
      disposable.dispose()
    }
  }
}

export function within(root: vscode.Uri, uri: vscode.Uri): boolean {
  if (root.scheme !== uri.scheme || root.authority !== uri.authority) {
    return false
  }
  const base = root.path.endsWith('/') ? root.path : `${root.path}/`
  return uri.path === root.path || uri.path.startsWith(base)
}
