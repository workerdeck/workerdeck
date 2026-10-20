import * as vscode from 'vscode'
import type { FileEntryKind, FileOpenMode, FilesCommand, FilesToHost, HostToFiles, UploadedFile, WireFileEntry } from './bridge-protocol.ts'
import { FileDecorations, within } from './file-decorations.ts'
import { WorkerdeckFileSystem } from './fsp.ts'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import { codiconCss, iconThemeRoot, languageIndex, languageOf, loadIconTheme, type LanguageIndex } from './icon-theme.ts'
import { isLocalHost } from './machine.ts'
import type { SessionRef } from './session-surface.ts'
import { WebviewViewHost } from './webview-host.ts'

type FilesRoot = { uri: vscode.Uri; session: SessionRef; local: boolean }

type MenuContext = { webviewSection?: string; uri?: string }

const REFRESH_DEBOUNCE_MS = 150

export async function sessionRootUri(store: HostStore, session: SessionRef): Promise<{ uri: vscode.Uri; local: boolean } | undefined> {
  if (!session.cwd) {
    return undefined
  }
  const local = await isLocalHost(store, session.host)
  const uri = local
    ? vscode.Uri.file(session.cwd)
    : vscode.Uri.from({ scheme: WorkerdeckFileSystem.scheme, authority: session.host.id.toLowerCase(), path: session.cwd })
  return { uri, local }
}

export class FilesViewProvider extends WebviewViewHost<FilesToHost, HostToFiles> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.files'

  protected readonly bundle = 'files.js'

  readonly #store: HostStore
  readonly #decorations = new FileDecorations()
  readonly #disposables: vscode.Disposable[] = []
  #root: FilesRoot | undefined
  #watcher: vscode.Disposable | undefined
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #pending = 0
  #pinned = false
  #selection: vscode.Uri[] = []
  #clipboard: { uris: vscode.Uri[]; cut: boolean } | undefined
  #languages: LanguageIndex | undefined

  constructor(extensionUri: vscode.Uri, store: HostStore, fsp: WorkerdeckFileSystem) {
    super(extensionUri)
    this.#store = store
    this.#disposables.push(
      this.#decorations,
      this.#decorations.onDidChange(() => this.#pushDecorations()),
      fsp.onDidChangeFile(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.#revealActive()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.#revealActive()),
      vscode.extensions.onDidChange(() => {
        this.#languages = undefined
        void this.#pushTheme()
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.experimental.modernUI')) {
          void this.#pushTheme()
        }
        if (e.affectsConfiguration('files.associations')) {
          this.#languages = undefined
          this.post({ kind: 'wd-files-refresh' })
        }
        if (e.affectsConfiguration('files.exclude')) {
          this.post({ kind: 'wd-files-refresh' })
        }
      }),
    )
  }

  get root(): FilesRoot | undefined {
    return this.#root
  }

  protected override resourceRoots(): vscode.Uri[] {
    const theme = iconThemeRoot()
    return [vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), 'out', 'media'), ...(theme ? [theme] : [])]
  }

  protected override wire(view: vscode.WebviewView): void {
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.refresh()
      } else {
        void vscode.commands.executeCommand('setContext', 'workerdeck.filesFocus', false)
      }
    })
  }

  protected override onReady(): void {
    void this.#pushTheme()
    this.#pushRoot()
  }

  async setSession(session: SessionRef | undefined): Promise<void> {
    if (this.#pinned) {
      return
    }
    const ticket = ++this.#pending
    const resolved = session && (await sessionRootUri(this.#store, session))
    if (ticket !== this.#pending) {
      return
    }
    if (resolved && this.#root?.uri.toString() === resolved.uri.toString()) {
      this.#root = { ...resolved, session: session! }
      return
    }
    this.#root = resolved && { ...resolved, session: session! }
    this.#selection = []
    void vscode.commands.executeCommand('setContext', 'workerdeck.filesEditing', false)
    this.#watcher?.dispose()
    this.#watcher = undefined
    if (this.#root?.local) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.#root.uri, '**/*'))
      watcher.onDidCreate(() => this.refresh())
      watcher.onDidDelete(() => this.refresh())
      this.#watcher = watcher
    }
    void vscode.commands.executeCommand('setContext', 'workerdeck.filesLocal', this.#root?.local === true)
    void vscode.commands.executeCommand('setContext', 'workerdeck.filesHasRoot', this.#root !== undefined)
    this.#pushRoot()
  }

  // Development hosts only: browse a plain folder with no gateway behind it, so the view can be exercised in isolation.
  showFolder(uri: vscode.Uri): void {
    this.#pinned = true
    const host = { id: 'local-folder', name: 'Folder', baseUrl: '' }
    this.#root = { uri, local: uri.scheme === 'file', session: { host, sessionId: 'local-folder', cwd: uri.path } }
    void vscode.commands.executeCommand('setContext', 'workerdeck.filesLocal', this.#root.local)
    void vscode.commands.executeCommand('setContext', 'workerdeck.filesHasRoot', true)
    this.#pushRoot()
  }

  refresh(): void {
    clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => this.post({ kind: 'wd-files-refresh' }), REFRESH_DEBOUNCE_MS)
  }

  #pushRoot(): void {
    const view = this.view
    if (!view) {
      return
    }
    const root = this.#root
    view.description = root ? `${root.session.host.name}: ${root.uri.path}` : undefined
    if (!this.ready) {
      return
    }
    if (!root) {
      this.post({ kind: 'wd-files-root', message: 'Select a session to browse its folder.' })
      return
    }
    this.post({
      kind: 'wd-files-root',
      root: {
        uri: root.uri.toString(),
        name: basename(root.uri),
        label: root.local ? root.uri.fsPath : `${root.session.host.name}:${root.uri.path}`,
        local: root.local,
        parentName: basename(vscode.Uri.joinPath(root.uri, '..')),
      },
    })
    this.#pushDecorations()
    this.#revealActive()
  }

  async #pushTheme(): Promise<void> {
    const view = this.view
    if (!view || !this.ready) {
      return
    }
    const theme = await loadIconTheme(view.webview)
    const codicons = codiconCss(view.webview)
    const allowed = view.webview.options.localResourceRoots ?? []
    const missing = theme.roots.filter((root) => !allowed.some((a) => a.toString() === root.toString()))
    if (missing.length > 0) {
      view.webview.options = { ...view.webview.options, localResourceRoots: [...allowed, ...missing] }
    }
    this.post({
      kind: 'wd-files-theme',
      css: `${codicons.css}\n${theme.css}`,
      fileIcons: theme.fileIcons,
      folderIcons: theme.folderIcons,
      hideArrows: theme.hideArrows,
      modern: vscode.workspace.getConfiguration('workbench').get<boolean>('experimental.modernUI') !== false,
    })
  }

  #pushDecorations(): void {
    if (this.#root && this.ready) {
      this.post({ kind: 'wd-files-decorations', decorations: this.#decorations.under(this.#root.uri) })
    }
  }

  #revealActive(): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined
    if (uri && this.ready) {
      this.#reveal(uri, false)
    }
  }

  #reveal(uri: vscode.Uri, focus: boolean): void {
    const root = this.#root?.uri
    if (!root || !within(root, uri) || uri.toString() === root.toString()) {
      return
    }
    const ancestors: string[] = []
    let dir = vscode.Uri.joinPath(uri, '..')
    while (within(root, dir) && dir.path !== root.path) {
      ancestors.unshift(dir.toString())
      dir = vscode.Uri.joinPath(dir, '..')
    }
    this.post({ kind: 'wd-files-reveal', uri: uri.toString(), ancestors, focus })
  }

  protected override async onMessage(msg: FilesToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-files-list': {
        await this.#list(vscode.Uri.parse(msg.uri))
        return
      }
      case 'wd-files-open': {
        await this.#open(uris(msg.uris), msg.mode)
        return
      }
      case 'wd-files-create': {
        await this.#create(vscode.Uri.parse(msg.parent), msg.name, msg.entry)
        return
      }
      case 'wd-files-rename': {
        await this.#rename(vscode.Uri.parse(msg.uri), msg.name)
        return
      }
      case 'wd-files-delete': {
        await this.#delete(uris(msg.uris))
        return
      }
      case 'wd-files-move': {
        await this.#move(uris(msg.uris), vscode.Uri.parse(msg.target), msg.copy)
        return
      }
      case 'wd-files-clipboard': {
        this.#setClipboard(uris(msg.uris), msg.cut)
        return
      }
      case 'wd-files-paste': {
        await this.#paste(vscode.Uri.parse(msg.target))
        return
      }
      case 'wd-files-upload': {
        await this.#upload(vscode.Uri.parse(msg.target), msg.files)
        return
      }
      case 'wd-files-drop-uris': {
        await this.#copyInto(uris(msg.uris), vscode.Uri.parse(msg.target))
        return
      }
      case 'wd-files-selection': {
        this.#selection = uris(msg.uris)
        return
      }
      case 'wd-files-editing': {
        void vscode.commands.executeCommand('setContext', 'workerdeck.filesEditing', msg.editing)
        return
      }
      case 'wd-files-focus': {
        void vscode.commands.executeCommand('setContext', 'workerdeck.filesFocus', msg.focused)
        return
      }
      case 'wd-files-copy-path': {
        await this.#copyPaths(uris(msg.uris), msg.relative)
        return
      }
      case 'wd-files-reveal-os': {
        await this.#revealInOS(vscode.Uri.parse(msg.uri))
        return
      }
      default: {
        return
      }
    }
  }

  async #list(dir: vscode.Uri): Promise<void> {
    let raw: [string, vscode.FileType][]
    try {
      raw = await vscode.workspace.fs.readDirectory(dir)
    } catch (err) {
      this.post({ kind: 'wd-files-dir', uri: dir.toString(), error: errorText(err) })
      return
    }
    const languages = (this.#languages ??= languageIndex())
    const excluded = excludedNames(dir)
    const entries: WireFileEntry[] = raw
      .filter(([name]) => !excluded.has(name))
      .map(([name, type]) => {
        const kind: FileEntryKind = (type & vscode.FileType.Directory) !== 0 ? 'folder' : 'file'
        const link = (type & vscode.FileType.SymbolicLink) !== 0
        const lang = kind === 'file' ? languageOf(languages, name) : undefined
        return { name, uri: vscode.Uri.joinPath(dir, name).toString(), kind, ...(lang ? { lang } : {}), ...(link ? { link } : {}) }
      })
      .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || compareNames(a.name, b.name))
    this.post({ kind: 'wd-files-dir', uri: dir.toString(), entries })
  }

  async #open(targets: vscode.Uri[], mode: FileOpenMode): Promise<void> {
    const options: vscode.TextDocumentShowOptions =
      mode === 'preview'
        ? { preview: true, preserveFocus: true }
        : mode === 'side'
          ? { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside }
          : { preview: false, preserveFocus: false }
    for (const uri of targets) {
      await vscode.commands.executeCommand('vscode.open', uri, options)
    }
  }

  async #create(parent: vscode.Uri, name: string, entry: FileEntryKind): Promise<void> {
    const uri = vscode.Uri.joinPath(parent, name)
    await guarded(async () => {
      if (await exists(uri)) {
        throw new Error(`A file or folder '${name}' already exists at this location.`)
      }
      if (entry === 'folder') {
        await vscode.workspace.fs.createDirectory(uri)
      } else {
        await vscode.workspace.fs.writeFile(uri, new Uint8Array())
      }
      this.#reveal(uri, true)
      if (entry === 'file') {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false })
      }
    })
    this.refresh()
  }

  async #rename(uri: vscode.Uri, name: string): Promise<void> {
    const target = vscode.Uri.joinPath(uri, '..', name)
    const edit = new vscode.WorkspaceEdit()
    edit.renameFile(uri, target)
    if (await vscode.workspace.applyEdit(edit)) {
      this.#reveal(target, true)
    } else {
      void vscode.window.showErrorMessage(`WorkerDeck: could not rename '${basename(uri)}'.`)
    }
    this.refresh()
  }

  async #delete(targets: vscode.Uri[]): Promise<void> {
    if (targets.length === 0) {
      return
    }
    const useTrash = targets[0]!.scheme === 'file'
    const confirmDelete = vscode.workspace.getConfiguration('explorer').get<boolean>('confirmDelete') !== false
    if (confirmDelete || !useTrash) {
      const detail = useTrash ? 'You can restore from the Trash.' : 'This is on a remote gateway: it cannot be undone.'
      const message = `Are you sure you want to ${useTrash ? 'delete' : 'permanently delete'} ${describe(targets)}?`
      if (!(await confirm(message, useTrash ? 'Move to Trash' : 'Delete', detail))) {
        return
      }
    }
    await guarded(async () => {
      for (const uri of targets) {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash })
      }
    })
    this.refresh()
  }

  async #move(sources: vscode.Uri[], target: vscode.Uri, copy: boolean): Promise<void> {
    if (copy) {
      await this.#copyInto(sources, target)
      return
    }
    const moves = sources.filter((uri) => vscode.Uri.joinPath(uri, '..').toString() !== target.toString() && !within(uri, target))
    if (moves.length === 0) {
      return
    }
    if (vscode.workspace.getConfiguration('explorer').get<boolean>('confirmDragAndDrop') !== false) {
      if (!(await confirm(`Are you sure you want to move ${describe(moves)} into '${basename(target)}'?`, 'Move'))) {
        return
      }
    }
    const edit = new vscode.WorkspaceEdit()
    for (const uri of moves) {
      edit.renameFile(uri, vscode.Uri.joinPath(target, basename(uri)))
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage('WorkerDeck: could not move the selection.')
    }
    this.refresh()
  }

  #setClipboard(targets: vscode.Uri[], cut: boolean): void {
    this.#clipboard = targets.length > 0 ? { uris: targets, cut } : undefined
    this.post({ kind: 'wd-files-cut', uris: cut ? targets.map((u) => u.toString()) : [] })
  }

  async #paste(target: vscode.Uri): Promise<void> {
    const clip = this.#clipboard
    if (!clip) {
      return
    }
    if (!clip.cut) {
      await this.#copyInto(clip.uris, target)
      return
    }
    const edit = new vscode.WorkspaceEdit()
    for (const uri of clip.uris) {
      edit.renameFile(uri, vscode.Uri.joinPath(target, basename(uri)))
    }
    await vscode.workspace.applyEdit(edit)
    this.#setClipboard([], false)
    this.refresh()
  }

  async #copyInto(sources: vscode.Uri[], target: vscode.Uri): Promise<void> {
    let last: vscode.Uri | undefined
    await guarded(async () => {
      for (const uri of sources) {
        last = await freeName(target, basename(uri))
        await vscode.workspace.fs.copy(uri, last, { overwrite: false })
      }
    })
    if (last) {
      this.#reveal(last, true)
    }
    this.refresh()
  }

  async #upload(target: vscode.Uri, files: UploadedFile[]): Promise<void> {
    let last: vscode.Uri | undefined
    await guarded(async () => {
      for (const file of files) {
        last = await freeName(target, file.name)
        await vscode.workspace.fs.writeFile(last, Uint8Array.from(Buffer.from(file.b64, 'base64')))
      }
    })
    if (last) {
      this.#reveal(last, true)
    }
    this.refresh()
  }

  async #copyPaths(targets: vscode.Uri[], relative: boolean): Promise<void> {
    const root = this.#root?.uri
    const paths = targets.map((uri) => (relative && root ? relativeTo(root, uri) : uri.scheme === 'file' ? uri.fsPath : uri.path))
    await vscode.env.clipboard.writeText(paths.join('\n'))
  }

  async #revealInOS(uri: vscode.Uri): Promise<void> {
    if (uri.scheme === 'file') {
      await vscode.commands.executeCommand('revealFileInOS', uri)
    }
  }

  #targets(context: MenuContext | undefined): vscode.Uri[] {
    const clicked = context?.uri ? vscode.Uri.parse(context.uri) : undefined
    if (!clicked) {
      return this.#selection
    }
    return this.#selection.some((u) => u.toString() === clicked.toString()) ? this.#selection : [clicked]
  }

  #folderOf(context: MenuContext | undefined): vscode.Uri | undefined {
    const clicked = context?.uri ? vscode.Uri.parse(context.uri) : undefined
    if (!clicked) {
      return this.#root?.uri
    }
    return context?.webviewSection === 'folder' ? clicked : vscode.Uri.joinPath(clicked, '..')
  }

  #command(command: FilesCommand, uri?: string): void {
    this.view?.show?.(false)
    this.post({ kind: 'wd-files-command', command, ...(uri ? { uri } : {}) })
  }

  commands(): Record<string, (...args: never[]) => unknown> {
    return {
      'workerdeck.files.refresh': () => this.refresh(),
      'workerdeck.files.newFile': (context?: MenuContext) => this.#command('newFile', context?.uri),
      'workerdeck.files.newFolder': (context?: MenuContext) => this.#command('newFolder', context?.uri),
      'workerdeck.files.collapseAll': () => this.#command('collapseAll'),
      'workerdeck.files.rename': (context?: MenuContext) => this.#command('rename', context?.uri),
      'workerdeck.files.delete': (context?: MenuContext) => this.#delete(this.#targets(context)),
      'workerdeck.files.cut': (context?: MenuContext) => this.#setClipboard(this.#targets(context), true),
      'workerdeck.files.copy': (context?: MenuContext) => this.#setClipboard(this.#targets(context), false),
      'workerdeck.files.paste': (context?: MenuContext) => {
        const folder = this.#folderOf(context)
        return folder && this.#paste(folder)
      },
      'workerdeck.files.openToSide': (context?: MenuContext) => this.#open(this.#targets(context), 'side'),
      'workerdeck.files.copyPath': (context?: MenuContext) => this.#copyPaths(this.#targets(context), false),
      'workerdeck.files.copyRelativePath': (context?: MenuContext) => this.#copyPaths(this.#targets(context), true),
      'workerdeck.files.revealInOS': (context?: MenuContext) => {
        const uri = this.#targets(context)[0] ?? this.#root?.uri
        return uri && this.#revealInOS(uri)
      },
      'workerdeck.files.openInTerminal': (context?: MenuContext) => {
        const dir = this.#folderOf(context)
        if (dir?.scheme === 'file') {
          vscode.window.createTerminal({ cwd: dir.fsPath, name: basename(dir) }).show()
        }
      },
      'workerdeck.files.findInFolder': (context?: MenuContext) => this.#findFile(this.#folderOf(context)),
      'workerdeck.files.findFile': () => this.#findFile(this.#root?.uri),
    }
  }

  async #findFile(base: vscode.Uri | undefined): Promise<void> {
    const root = this.#root
    const client = root && (await clientFor(this.#store, root.session.host))
    if (!root || !client || !base) {
      return
    }
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { uri: vscode.Uri }>()
    pick.placeholder = `Go to file in ${basename(base)}`
    pick.matchOnDescription = true
    let ticket = 0
    const search = async (q: string) => {
      const mine = ++ticket
      pick.busy = true
      try {
        const found = await client.findHostFiles(base.path, q, 50)
        if (mine !== ticket) {
          return
        }
        pick.items = found.matches.map((match) => {
          const uri = base.with({ path: match.path })
          const dir = match.relative.includes('/') ? match.relative.slice(0, match.relative.lastIndexOf('/')) : ''
          return { label: basename(uri), description: dir, uri, iconPath: vscode.ThemeIcon.File, resourceUri: uri }
        })
      } catch (err) {
        pick.items = []
        pick.placeholder = `Search unavailable: ${errorText(err)}`
      } finally {
        if (mine === ticket) {
          pick.busy = false
        }
      }
    }
    pick.onDidChangeValue((q) => void search(q))
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0]
      pick.hide()
      if (chosen) {
        void vscode.commands.executeCommand('vscode.open', chosen.uri)
      }
    })
    pick.onDidHide(() => pick.dispose())
    pick.show()
    void search('')
  }

  dispose(): void {
    clearTimeout(this.#refreshTimer)
    this.#watcher?.dispose()
    for (const disposable of this.#disposables) {
      disposable.dispose()
    }
  }
}

function uris(list: string[]): vscode.Uri[] {
  return list.map((u) => vscode.Uri.parse(u))
}

function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1) || uri.path
}

function relativeTo(root: vscode.Uri, uri: vscode.Uri): string {
  return within(root, uri) ? uri.path.slice(root.path.length).replace(/^\//, '') : uri.path
}

function describe(targets: vscode.Uri[]): string {
  return targets.length === 1 ? `'${basename(targets[0]!)}'` : `the following ${targets.length} files/folders`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// The Explorer's default sort: numeric-aware, case-insensitive, ties broken by the raw name.
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0)
}

// The Explorer honours `files.exclude`; only the plain-name and `**/name` keys, which cover the defaults, are matched here.
function excludedNames(dir: vscode.Uri): Set<string> {
  const config = vscode.workspace.getConfiguration('files', dir).get<Record<string, boolean>>('exclude') ?? {}
  const names = new Set<string>()
  for (const [glob, on] of Object.entries(config)) {
    const name = glob.replace(/^\*\*\//, '')
    if (on === true && !/[*?[\]{}/]/.test(name)) {
      names.add(name)
    }
  }
  return names
}

// `explorer.incrementalNaming: simple`: "name copy.ext", then "name copy 2.ext".
async function freeName(dir: vscode.Uri, name: string): Promise<vscode.Uri> {
  let candidate = vscode.Uri.joinPath(dir, name)
  if (!(await exists(candidate))) {
    return candidate
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    candidate = vscode.Uri.joinPath(dir, `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`)
    if (!(await exists(candidate))) {
      return candidate
    }
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

async function confirm(message: string, action: string, detail?: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action
}

async function guarded(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: ${errorText(err)}`)
  }
}
