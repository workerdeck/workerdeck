import * as vscode from 'vscode'
import {
  HOST_SEARCH_MAX_RESULTS,
  replacementFor,
  type HostSearchEvent,
  type HostSearchRange,
  type HostSearchRequest,
  type ReplaceOptions,
} from '@workerdeck/protocol'
import type { FileOpenMode, HostToSearch, SearchCommand, SearchToHost, WireReplaceFile, WireSearchSettings } from './bridge-protocol.ts'
import { sessionRootUri } from './files-view.ts'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import { codiconCss, iconThemeRoot, languageIndex, loadIconTheme } from './icon-theme.ts'
import type { SessionRef } from './session-surface.ts'
import { WebviewViewHost } from './webview-host.ts'

type SearchRoot = { uri: vscode.Uri; session: SessionRef; local: boolean; canSearch: boolean }

type Seed = { query?: string; includes?: string }

const BATCH_MS = 40
const PREVIEW_SCHEME = 'workerdeck-replace'

export class SearchViewProvider extends WebviewViewHost<SearchToHost, HostToSearch> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.search'

  protected readonly bundle = 'search.js'

  readonly #store: HostStore
  readonly #runs = new Map<number, AbortController>()
  readonly #previews = new Map<string, string>()
  readonly #previewChanged = new vscode.EventEmitter<vscode.Uri>()
  readonly #disposables: vscode.Disposable[] = []
  #root: SearchRoot | undefined
  #pending = 0
  #seed: Seed | undefined
  #seedCommand: 'focus' | 'replace' = 'focus'

  constructor(extensionUri: vscode.Uri, store: HostStore) {
    super(extensionUri)
    this.#store = store
    this.#disposables.push(
      this.#previewChanged,
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
        onDidChange: this.#previewChanged.event,
        provideTextDocumentContent: (uri) => this.#previews.get(uri.toString()) ?? '',
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('search') || e.affectsConfiguration('files.exclude')) {
          this.#pushSettings()
        }
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('files.associations')) {
          void this.#pushTheme()
        }
      }),
    )
  }

  dispose(): void {
    for (const controller of this.#runs.values()) {
      controller.abort()
    }
    for (const disposable of this.#disposables) {
      disposable.dispose()
    }
  }

  protected override resourceRoots(): vscode.Uri[] {
    const theme = iconThemeRoot()
    return [vscode.Uri.joinPath(vscode.Uri.file(vscode.env.appRoot), 'out', 'media'), ...(theme ? [theme] : [])]
  }

  protected override wire(view: vscode.WebviewView): void {
    view.onDidChangeVisibility(() => {
      if (!view.visible) {
        this.#setFocus(false, false)
      }
    })
  }

  protected override onReady(): void {
    void this.#pushTheme()
    this.#pushSettings()
    this.#pushRoot()
    if (this.#seed) {
      this.post({ kind: 'wd-search-command', command: this.#seedCommand, seed: this.#seed })
      this.#seed = undefined
    }
  }

  protected override resetForReload(): void {
    for (const controller of this.#runs.values()) {
      controller.abort()
    }
    this.#runs.clear()
  }

  async setSession(session: SessionRef | undefined): Promise<void> {
    const ticket = ++this.#pending
    const resolved = session && (await sessionRootUri(this.#store, session))
    if (ticket !== this.#pending) {
      return
    }
    if (resolved && session && this.#root?.uri.toString() === resolved.uri.toString()) {
      this.#root = { ...this.#root, session }
      return
    }
    const canSearch = resolved && session ? await this.#canSearch(session) : false
    if (ticket !== this.#pending) {
      return
    }
    this.#root = resolved && session ? { ...resolved, session, canSearch } : undefined
    void vscode.commands.executeCommand('setContext', 'workerdeck.searchHasRoot', this.#root !== undefined)
    this.#pushRoot()
  }

  async focus(seed: Seed = {}, command: 'focus' | 'replace' = 'focus'): Promise<void> {
    const editor = vscode.window.activeTextEditor
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : ''
    const query = seed.query ?? (selected && !selected.includes('\n') ? selected : undefined)
    const next = { ...seed, ...(query !== undefined ? { query } : {}) }
    await vscode.commands.executeCommand(`${SearchViewProvider.viewId}.focus`)
    if (this.ready) {
      this.post({ kind: 'wd-search-command', command, seed: next })
    } else {
      this.#seed = next
      this.#seedCommand = command
    }
  }

  async searchIn(folder: vscode.Uri | undefined): Promise<void> {
    const root = this.#root?.uri
    if (!folder || !root || folder.toString() === root.toString()) {
      await this.focus()
      return
    }
    const relative = folder.path.startsWith(`${root.path}/`) ? folder.path.slice(root.path.length + 1) : undefined
    await this.focus(relative ? { includes: `./${relative}` } : {})
  }

  commands(): Record<string, (...args: never[]) => unknown> {
    const command = (name: SearchCommand) => () => this.post({ kind: 'wd-search-command', command: name })
    return {
      'workerdeck.search.find': () => this.focus(),
      'workerdeck.search.refresh': command('refresh'),
      'workerdeck.search.clear': command('clear'),
      'workerdeck.search.viewAsTree': command('viewAsTree'),
      'workerdeck.search.viewAsList': command('viewAsList'),
      'workerdeck.search.collapseAll': command('collapseAll'),
      'workerdeck.search.expandAll': command('expandAll'),
      'workerdeck.search.replace': () => this.focus({}, 'replace'),
      'workerdeck.search.replaceAll': command('replaceAll'),
      'workerdeck.search.toggleCase': command('toggleCase'),
      'workerdeck.search.toggleWord': command('toggleWord'),
      'workerdeck.search.toggleRegex': command('toggleRegex'),
      'workerdeck.search.togglePreserveCase': command('togglePreserveCase'),
    }
  }

  protected override async onMessage(msg: SearchToHost): Promise<void> {
    switch (msg.kind) {
      case 'wd-search-run': {
        await this.#run(msg.id, msg.request)
        return
      }
      case 'wd-search-cancel': {
        this.#runs.get(msg.id)?.abort()
        this.#runs.delete(msg.id)
        return
      }
      case 'wd-search-open': {
        await this.#open(msg.path, msg.range, msg.mode)
        return
      }
      case 'wd-search-replace': {
        await this.#replace(msg.options, msg.files, msg.confirm)
        return
      }
      case 'wd-search-preview': {
        await this.#preview(msg.options, msg.file, msg.range)
        return
      }
      case 'wd-search-focus': {
        this.#setFocus(msg.focused, msg.input === true)
        return
      }
      case 'wd-search-view': {
        void vscode.commands.executeCommand('setContext', 'workerdeck.searchTree', msg.tree)
        void vscode.commands.executeCommand('setContext', 'workerdeck.searchCollapsed', msg.collapsed)
        void vscode.commands.executeCommand('setContext', 'workerdeck.searchHasResults', msg.hasResults)
        void vscode.commands.executeCommand('setContext', 'workerdeck.searchHasQuery', msg.hasQuery)
        return
      }
      case 'wd-search-copy': {
        await vscode.env.clipboard.writeText(msg.text)
        return
      }
      case 'wd-search-open-settings': {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'search.exclude')
        return
      }
      case 'wd-ready': {
        return
      }
    }
  }

  #setFocus(focused: boolean, input: boolean): void {
    void vscode.commands.executeCommand('setContext', 'workerdeck.searchFocus', focused)
    void vscode.commands.executeCommand('setContext', 'workerdeck.searchInputFocus', focused && input)
  }

  async #canSearch(session: SessionRef): Promise<boolean> {
    const client = await clientFor(this.#store, session.host)
    try {
      return (await client?.listHostRoots())?.canSearch === true
    } catch {
      return false
    }
  }

  #pushRoot(): void {
    if (!this.ready) {
      return
    }
    const root = this.#root
    if (!root) {
      this.post({ kind: 'wd-search-root', message: 'Select a session to search its folder.' })
      return
    }
    this.post({
      kind: 'wd-search-root',
      root: {
        path: root.uri.path,
        label: root.local ? root.uri.fsPath : `${root.session.host.name}:${root.uri.path}`,
        local: root.local,
        canSearch: root.canSearch,
      },
    })
  }

  #pushSettings(): void {
    if (this.ready) {
      this.post({ kind: 'wd-search-settings', settings: searchSettings() })
    }
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
    const languages = languageIndex()
    this.post({
      kind: 'wd-search-theme',
      css: `${codicons.css}\n${theme.css}`,
      fileIcons: theme.fileIcons,
      languages: { names: Object.fromEntries(languages.names), extensions: Object.fromEntries(languages.extensions) },
    })
  }

  async #run(id: number, request: HostSearchRequest): Promise<void> {
    const root = this.#root
    const client = root && (await clientFor(this.#store, root.session.host))
    if (!root || !client) {
      this.post({ kind: 'wd-search-events', id, events: [], end: true, failure: 'The gateway is not reachable.' })
      return
    }
    const controller = new AbortController()
    this.#runs.set(id, controller)
    let batch: HostSearchEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (end?: boolean, failure?: string) => {
      clearTimeout(timer)
      timer = undefined
      if (!controller.signal.aborted) {
        this.post({ kind: 'wd-search-events', id, events: batch, ...(end ? { end } : {}), ...(failure ? { failure } : {}) })
      }
      batch = []
    }
    try {
      for await (const event of client.searchHostFiles({ ...request, path: root.uri.path }, { signal: controller.signal })) {
        batch.push(event)
        timer ??= setTimeout(() => flush(), BATCH_MS)
      }
      flush(true)
    } catch (err) {
      flush(true, err instanceof Error ? err.message : String(err))
    } finally {
      clearTimeout(timer)
      this.#runs.delete(id)
    }
  }

  #uri(path: string): vscode.Uri | undefined {
    return this.#root?.uri.with({ path })
  }

  async #open(path: string, range: HostSearchRange | undefined, mode: FileOpenMode): Promise<void> {
    const uri = this.#uri(path)
    if (!uri) {
      return
    }
    const selection = range && toRange(range)
    const options: vscode.TextDocumentShowOptions =
      mode === 'preview'
        ? { preview: true, preserveFocus: true, selection }
        : mode === 'side'
          ? { preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.Beside, selection }
          : { preview: false, preserveFocus: false, selection }
    await vscode.commands.executeCommand('vscode.open', uri, options)
  }

  async #replace(options: ReplaceOptions, files: WireReplaceFile[], confirm: boolean): Promise<void> {
    const total = files.reduce((sum, file) => sum + file.matches.length, 0)
    if (total === 0) {
      return
    }
    if (confirm) {
      const occurrences = total === 1 ? '1 occurrence' : `${total} occurrences`
      const across = files.length === 1 ? '1 file' : `${files.length} files`
      const message = options.replace
        ? `Replace ${occurrences} across ${across} with '${options.replace}'?`
        : `Replace ${occurrences} across ${across}?`
      const picked = await vscode.window.showWarningMessage(message, { modal: true }, 'Replace')
      if (picked !== 'Replace') {
        return
      }
    }
    const edit = new vscode.WorkspaceEdit()
    const applied: WireReplaceFile[] = []
    const toSave: vscode.TextDocument[] = []
    let stale = 0
    for (const file of files) {
      const uri = this.#uri(file.path)
      if (!uri) {
        continue
      }
      let document: vscode.TextDocument
      try {
        document = await vscode.workspace.openTextDocument(uri)
      } catch {
        stale += file.matches.length
        continue
      }
      const kept = file.matches.filter((match) => document.getText(toRange(match)) === match.text)
      stale += file.matches.length - kept.length
      for (const match of kept) {
        edit.replace(uri, toRange(match), replacementFor(match.text, options))
      }
      if (kept.length > 0) {
        applied.push({ path: file.path, matches: kept })
        if (!document.isDirty) {
          toSave.push(document)
        }
      }
    }
    if (applied.length > 0 && !(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage('WorkerDeck: the replacement could not be applied.')
      return
    }
    await Promise.all(toSave.map((document) => document.save()))
    this.post({ kind: 'wd-search-replaced', files: applied })
    if (stale > 0) {
      void vscode.window.showWarningMessage(
        `WorkerDeck: ${stale === 1 ? '1 match' : `${stale} matches`} changed since the search and ${stale === 1 ? 'was' : 'were'} not replaced.`,
      )
    }
  }

  async #preview(options: ReplaceOptions, file: WireReplaceFile, range: HostSearchRange | undefined): Promise<void> {
    const uri = this.#uri(file.path)
    if (!uri) {
      return
    }
    const document = await vscode.workspace.openTextDocument(uri)
    const replaced = [...file.matches]
      .filter((match) => document.getText(toRange(match)) === match.text)
      .map((match) => ({
        start: document.offsetAt(toRange(match).start),
        end: document.offsetAt(toRange(match).end),
        text: replacementFor(match.text, options),
      }))
      .sort((a, b) => b.start - a.start)
    let text = document.getText()
    for (const change of replaced) {
      text = text.slice(0, change.start) + change.text + text.slice(change.end)
    }
    const preview = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: uri.path, query: uri.scheme })
    this.#previews.set(preview.toString(), text)
    this.#previewChanged.fire(preview)
    const name = uri.path.slice(uri.path.lastIndexOf('/') + 1)
    await vscode.commands.executeCommand('vscode.diff', uri, preview, `${name} ↔ ${name} (Replace Preview)`, {
      preview: true,
      preserveFocus: true,
      ...(range ? { selection: toRange(range) } : {}),
    })
  }
}

function toRange(range: HostSearchRange): vscode.Range {
  return new vscode.Range(range.line, range.column, range.endLine, range.endColumn)
}

function enabledGlobs(value: unknown): string[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, enabled]) => enabled === true)
    .map(([glob]) => glob)
}

function searchSettings(): WireSearchSettings {
  const search = vscode.workspace.getConfiguration('search')
  const files = vscode.workspace.getConfiguration('files')
  const maxResults = search.get<number | null>('maxResults')
  return {
    excludes: [...new Set([...enabledGlobs(files.get('exclude')), ...enabledGlobs(search.get('exclude'))])],
    searchOnType: search.get<boolean>('searchOnType') !== false,
    debounceMs: search.get<number>('searchOnTypeDebouncePeriod') ?? 300,
    maxResults: typeof maxResults === 'number' && maxResults > 0 ? Math.min(maxResults, HOST_SEARCH_MAX_RESULTS) : HOST_SEARCH_MAX_RESULTS,
    viewMode: search.get<string>('defaultViewMode') === 'tree' ? 'tree' : 'list',
    collapseResults: search.get<WireSearchSettings['collapseResults']>('collapseResults') ?? 'alwaysExpand',
    lineNumbers: search.get<boolean>('showLineNumbers') === true,
  }
}
