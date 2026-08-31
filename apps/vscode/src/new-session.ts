import * as vscode from 'vscode'
import type { HostFileRoot, ModelOption, PermissionMode, ProfileInfo, SdkSessionSummary, SessionInfo } from '@workerdeck/protocol'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'
import { workspaceScope } from './workspace-scope.ts'

type AdapterChoice = {
  host: WireHost
  profile: ProfileInfo
  explicit: boolean
}

type CreateBody = {
  cwd: string
  resume?: string
  title?: string
  model?: string
  permissionMode?: PermissionMode
}

type PickOptions<T extends vscode.QuickPickItem> = {
  title: string
  placeHolder: string
  activeItem?: T
  value?: string
  step?: number
  totalSteps?: number
  freeText?: (value: string) => T | undefined
}

export type NewSessionDeps = {
  store: HostStore
  state: () => SidebarState
  reveal: (hostId: string, sessionId: string) => Promise<void>
  refresh: () => Promise<void>
}

const CANCEL = Symbol('cancel')
const BACK = Symbol('back')
type Answer<T> = T | typeof CANCEL | typeof BACK

export const createSession = async (deps: NewSessionDeps): Promise<void> => {
  await run(deps, { resume: false })
}

export const resumeSession = async (deps: NewSessionDeps): Promise<void> => {
  await run(deps, { resume: true })
}

const run = async (deps: NewSessionDeps, options: { resume: boolean }): Promise<void> => {
  const adapters = await loadAdapters(deps)
  if (adapters === undefined) {
    return
  }
  if (adapters.length === 0) {
    void vscode.window.showInformationMessage('WorkerDeck: no gateway is reachable. Add one in the Gateways view.')
    return
  }

  let step = 0
  let adapter: AdapterChoice | undefined
  let cwd: string | undefined

  while (step < 3) {
    if (step === 0) {
      if (adapters.length === 1) {
        adapter = adapters[0]
        step = 1
        continue
      }
      const picked = await pickAdapter(adapters, adapter)
      if (picked === CANCEL) {
        return
      }
      if (picked === BACK) {
        return
      }
      adapter = picked
      step = 1
    } else if (step === 1) {
      const picked = await pickFolder(deps, adapter!, cwd)
      if (picked === CANCEL) {
        return
      }
      if (picked === BACK) {
        if (adapters.length === 1) {
          return
        }
        step = 0
        continue
      }
      cwd = picked
      step = 2
    } else {
      const done = options.resume ? await pickAndResume(deps, adapter!, cwd!) : await pickModelAndCreate(deps, adapter!, cwd!)
      if (done === BACK) {
        step = 1
        continue
      }
      return
    }
  }
}

const loadAdapters = async (deps: NewSessionDeps): Promise<AdapterChoice[] | undefined> => {
  const hosts = deps.state().hosts.filter((h) => h.probe === 'connected')
  if (hosts.length === 0) {
    return []
  }
  const choices = await vscode.window.withProgress(
    { location: { viewId: 'workerdeck.sessions' }, title: 'Loading adapters…' },
    async () => {
      const perHost = await Promise.all(
        hosts.map(async (host) => {
          const client = await clientFor(deps.store, host)
          if (!client) {
            return []
          }
          try {
            const { profiles } = await client.listProfiles()
            return profiles.map((profile) => ({
              host,
              profile,
              explicit: profiles.length > 1,
            }))
          } catch {
            return []
          }
        }),
      )
      return perHost.flat()
    },
  )
  return choices.sort((a, b) => Number(a.profile.available === false) - Number(b.profile.available === false))
}

type AdapterItem = vscode.QuickPickItem & { choice: AdapterChoice }

const pickAdapter = async (adapters: readonly AdapterChoice[], current: AdapterChoice | undefined): Promise<Answer<AdapterChoice>> => {
  const multiGateway = new Set(adapters.map((a) => a.host.id)).size > 1
  const items: AdapterItem[] = adapters.map((choice) => {
    const engine = choice.profile.engine ?? 'claude'
    return {
      label: choice.profile.available === false ? `$(warning) ${engine}` : engine,
      description: [choice.profile.name === engine ? undefined : choice.profile.name, multiGateway ? choice.host.name : undefined]
        .filter(Boolean)
        .join(' · '),
      detail: choice.profile.available === false ? (choice.profile.unavailableReason ?? 'credentials look unavailable') : undefined,
      choice,
    }
  })
  const picked = await showPick(items, {
    title: 'New session: adapter',
    placeHolder: 'Which adapter should run this session?',
    activeItem: items.find((i) => i.choice === current),
    step: 1,
    totalSteps: 3,
  })
  return picked === CANCEL || picked === BACK ? picked : picked.choice
}

const pickFolder = async (deps: NewSessionDeps, adapter: AdapterChoice, current: string | undefined): Promise<Answer<string>> => {
  const host = adapter.host
  const candidates: { path: string; hint: string; verified: boolean }[] = []
  const add = (path: string, hint: string, verified: boolean) => {
    if (path && !candidates.some((c) => c.path === path)) {
      candidates.push({ path, hint, verified })
    }
  }

  // An absent `/fs/*` route (host files not configured) is a 404 — a fine answer, not an error.
  const roots = await hostRoots(deps, host)
  const underRoot = (path: string) => roots.some((r) => path === r.path || path.startsWith(r.path.endsWith('/') ? r.path : `${r.path}/`))

  if (current) {
    add(current, 'chosen', true)
  }
  for (const root of workspaceScope()?.roots ?? []) {
    if (root.hostId) {
      if (root.hostId.toLowerCase() === host.id.toLowerCase()) {
        add(root.path, 'this window', true)
      }
    } else if (host.local || underRoot(root.path)) {
      add(root.path, 'this window', true)
    } else {
      add(root.path, `this window · unverified on ${host.name}`, false)
    }
  }
  add(host.cwdSuggestion ?? '', 'suggested', true)
  for (const info of deps.state().sessions[host.id] ?? []) {
    add(info.cwd, 'recent session', true)
  }
  for (const root of roots) {
    add(root.path, 'on the gateway', true)
  }

  type FolderItem = vscode.QuickPickItem & { path?: string; browse?: boolean }
  const items: FolderItem[] = candidates.map((c) => ({
    label: c.path,
    description: c.hint,
    iconPath: new vscode.ThemeIcon('folder'),
    path: c.path,
    // The input arrives prefilled, which would otherwise filter the list down to the one row matching it.
    alwaysShow: true,
  }))
  if (host.local || roots.length > 0) {
    items.push({
      label: 'Browse…',
      description: host.local ? undefined : `on ${host.name}`,
      iconPath: new vscode.ThemeIcon('folder-opened'),
      browse: true,
      alwaysShow: true,
    })
  }

  const preset = current ?? (candidates.find((c) => c.verified) ?? candidates[0])?.path
  const picked = await showPick(items, {
    title: 'New session: working folder',
    placeHolder: host.local ? 'Pick a folder, or type an absolute path' : `Pick a folder on ${host.name}, or type an absolute path`,
    value: preset,
    activeItem: items.find((i) => i.path === preset),
    step: 2,
    totalSteps: 3,
    freeText: (value) =>
      value.startsWith('/') && !candidates.some((c) => c.path === value)
        ? {
            label: value,
            description: 'use this path',
            iconPath: new vscode.ThemeIcon('folder'),
            path: value,
            alwaysShow: true,
          }
        : undefined,
  })
  if (picked === CANCEL || picked === BACK) {
    return picked
  }
  if (picked.browse) {
    const chosen = host.local ? await browseLocally(candidates[0]?.path) : await browseGateway(deps, host, roots)
    if (!chosen) {
      return pickFolder(deps, adapter, current)
    }
    return chosen
  }
  return picked.path!
}

const hostRoots = async (deps: NewSessionDeps, host: WireHost): Promise<HostFileRoot[]> => {
  const client = await clientFor(deps.store, host)
  if (!client) {
    return []
  }
  try {
    return (await client.listHostRoots()).roots
  } catch {
    return []
  }
}

const browseLocally = async (start: string | undefined): Promise<string | undefined> => {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use folder',
    defaultUri: start ? vscode.Uri.file(start) : undefined,
  })
  return chosen?.[0]?.fsPath
}

const browseGateway = async (deps: NewSessionDeps, host: WireHost, roots: readonly HostFileRoot[]): Promise<string | undefined> => {
  const client = await clientFor(deps.store, host)
  if (!client) {
    return undefined
  }
  let dir = roots.length === 1 ? roots[0]!.path : undefined

  if (dir === undefined) {
    type RootItem = vscode.QuickPickItem & { path: string }
    const picked = await showPick<RootItem>(
      roots.map((r) => ({
        label: r.name,
        description: r.path,
        iconPath: new vscode.ThemeIcon('root-folder'),
        path: r.path,
      })),
      { title: `Browse ${host.name}`, placeHolder: 'Which root?' },
    )
    if (picked === CANCEL || picked === BACK) {
      return undefined
    }
    dir = picked.path
  }

  for (;;) {
    let listing: Awaited<ReturnType<typeof client.listHostDir>>
    try {
      listing = await vscode.window.withProgress({ location: { viewId: 'workerdeck.sessions' }, title: 'Listing…' }, () =>
        client.listHostDir(dir!),
      )
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: cannot list ${dir} — ${message(err)}`)
      return undefined
    }
    const dirs = listing.entries.filter((e) => e.type === 'dir' || e.type === 'symlink')
    const parent = listing.path.replace(/\/[^/]+\/*$/, '') || '/'
    // `..` only below a root: the route would refuse anything above one.
    const atRoot = roots.some((r) => r.path === listing.path)

    type Entry = vscode.QuickPickItem & { path?: string; use?: boolean }
    const items: Entry[] = [
      { label: 'Use this folder', description: listing.path, use: true, alwaysShow: true },
      ...(atRoot || parent === listing.path ? [] : [{ label: '..', description: parent, path: parent, alwaysShow: true }]),
      ...dirs.map((e) => ({
        label: e.name,
        iconPath: new vscode.ThemeIcon('folder'),
        path: e.path,
      })),
    ]
    const picked = await showPick(items, {
      title: `Browse ${host.name}`,
      placeHolder: listing.truncated ? `${listing.path} (truncated)` : listing.path,
    })
    if (picked === CANCEL || picked === BACK) {
      return undefined
    }
    if (picked.use) {
      return listing.path
    }
    dir = picked.path!
  }
}

const lastSessionOf = (deps: NewSessionDeps, adapter: AdapterChoice): SessionInfo | undefined => {
  const engine = adapter.profile.engine ?? 'claude'
  return (
    (deps.state().sessions[adapter.host.id] ?? [])
      .filter((s) =>
        // `SessionInfo.profile` is the RESOLVED name, present even when the create call left
        // it implicit, so it is the precise test. Engine is the fallback for an older server.
        s.profile !== undefined ? s.profile === adapter.profile.name : (s.engine ?? 'claude') === engine,
      )
      // The gateway's list order is its own business; recency is the question here.
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))[0]
  )
}

const pickModelAndCreate = async (deps: NewSessionDeps, adapter: AdapterChoice, cwd: string): Promise<Answer<void>> => {
  const previous = lastSessionOf(deps, adapter)
  const mode = resolveMode(adapter, previous)
  const models = adapter.profile.models ?? []
  if (models.length === 0) {
    await create(deps, adapter, { cwd, permissionMode: mode })
    return undefined
  }

  // Only the last session's OWN model preselects a catalog row: "unset" is a different
  // request from "this id", the gateway filling an unset model from the profile.
  const preferred = previous?.model
  const isPreferred = (m: ModelOption) => preferred !== undefined && (m.value === preferred || m.resolvedModel === preferred)
  // `value: undefined` is the sentinel row protocol assigns to clients — catalogs never carry one, and without it
  // the profile's own default is unreachable.
  type ModelItem = vscode.QuickPickItem & { value?: string }
  const fallbackRow: ModelItem = {
    label: 'Profile default',
    description: previous?.model === undefined ? 'default' : undefined,
    detail: adapter.profile.defaultModel ?? "whatever the profile's engine is configured for",
    value: undefined,
  }
  const items: ModelItem[] = [
    ...models.map((m) => ({
      label: m.displayName,
      description: isPreferred(m) ? 'last used' : undefined,
      detail: m.description ?? m.resolvedModel,
      value: m.value,
    })),
    fallbackRow,
  ]
  const picked = await showPick(items, {
    title: 'New session: model',
    placeHolder: `Model for this session — permission mode: ${modeLabel(mode)}`,
    activeItem: items[models.findIndex(isPreferred)] ?? fallbackRow,
    step: 3,
    totalSteps: 3,
  })
  if (picked === CANCEL) {
    return CANCEL
  }
  if (picked === BACK) {
    return BACK
  }
  await create(deps, adapter, { cwd, model: picked.value, permissionMode: mode })
  return undefined
}

const resolveMode = (adapter: AdapterChoice, previous: SessionInfo | undefined): PermissionMode | undefined => {
  const pinned = vscode.workspace.getConfiguration('workerdeck').get<string>('newSession.permissionMode', 'remember')
  const wanted =
    pinned && pinned !== 'remember' ? (pinned as PermissionMode) : (previous?.permissionMode ?? adapter.profile.defaults?.permissionMode)
  if (!wanted) {
    return undefined
  }
  // The profile's OWN record, not the static table keyed by engine: it is what the
  // create call is actually checked against.
  const caps = adapter.profile.capabilities ?? ENGINE_CAPABILITIES[adapter.profile.engine ?? 'claude']
  return caps.permissionModes.includes(wanted) ? wanted : undefined
}

const modeLabel = (mode: PermissionMode | undefined): string => {
  // 'default' is spelled "Manual" everywhere a person reads it (PERMISSION_MODES in ui):
  // the wire name would read as "the default", the opposite of what it means.
  if (mode === undefined || mode === 'default') {
    return 'Manual'
  }
  if (mode === 'acceptEdits') {
    return 'Accept edits'
  }
  if (mode === 'bypassPermissions') {
    return 'Bypass'
  }
  if (mode === 'dontAsk') {
    return "Don't ask"
  }
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

const pickAndResume = async (deps: NewSessionDeps, adapter: AdapterChoice, cwd: string): Promise<Answer<void>> => {
  const caps = adapter.profile.capabilities ?? ENGINE_CAPABILITIES[adapter.profile.engine ?? 'claude']
  if (!caps.listSessions) {
    void vscode.window.showInformationMessage(`WorkerDeck: ${adapter.profile.engine ?? 'claude'} cannot list stored sessions.`)
    return undefined
  }
  const client = await clientFor(deps.store, adapter.host)
  if (!client) {
    return undefined
  }

  let stored: SdkSessionSummary[]
  try {
    stored = await vscode.window.withProgress({ location: { viewId: 'workerdeck.sessions' }, title: 'Loading sessions…' }, () =>
      client.listSdkSessions({
        dir: cwd,
        limit: 20,
        profile: adapter.explicit ? adapter.profile.name : undefined,
      }),
    )
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: ${message(err)}`)
    return undefined
  }
  if (stored.length === 0) {
    void vscode.window.showInformationMessage(`WorkerDeck: no stored sessions in ${cwd}.`)
    return BACK
  }

  type StoredItem = vscode.QuickPickItem & { stored: SdkSessionSummary }
  const items: StoredItem[] = stored.map((s) => ({
    label: s.customTitle ?? s.summary,
    description: s.gitBranch,
    detail: new Date(s.lastModified).toLocaleString(),
    stored: s,
  }))
  const picked = await showPick(items, {
    title: 'Resume session',
    placeHolder: `Stored sessions in ${cwd}`,
    step: 3,
    totalSteps: 3,
  })
  if (picked === CANCEL) {
    return CANCEL
  }
  if (picked === BACK) {
    return BACK
  }
  await create(deps, adapter, {
    cwd: picked.stored.cwd ?? cwd,
    resume: picked.stored.sessionId,
    // Without it a resumed session is titleless: the derived fallback reads a first prompt that a resume never sends.
    title: (picked.stored.customTitle ?? picked.stored.summary).trim() || undefined,
    // A resumed thread carries no mode of its own, so leaving this unset would silently
    // ignore a pinned "always Auto". Model stays unset: the thread already has one.
    permissionMode: resolveMode(adapter, lastSessionOf(deps, adapter)),
  })
  return undefined
}

const create = async (deps: NewSessionDeps, adapter: AdapterChoice, body: CreateBody): Promise<void> => {
  const client = await clientFor(deps.store, adapter.host)
  if (!client) {
    return
  }
  // A profile with no catalog skips the model step entirely, so an inherited `bypassPermissions` would otherwise
  // reach a running session without ever having been shown.
  const modeNote = body.permissionMode && body.permissionMode !== 'default' ? ` · ${modeLabel(body.permissionMode)}` : ''
  try {
    const info = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `WorkerDeck: creating session…${modeNote}`,
      },
      () =>
        client.createSession({
          cwd: body.cwd,
          profile: adapter.explicit ? adapter.profile.name : undefined,
          resume: body.resume,
          model: body.model,
          permissionMode: body.permissionMode,
          // The CLI only allows bypass when the process was spawned for it: decided here or
          // never, and asking for the mode without this flag is asking to be refused.
          allowDangerouslySkipPermissions: body.permissionMode === 'bypassPermissions' ? true : undefined,
          meta: body.title ? { title: body.title } : undefined,
        }),
    )
    await deps.refresh()
    await deps.reveal(adapter.host.id, info.id)
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not create the session — ${message(err)}`)
  }
}

const message = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err)
}

const showPick = <T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T>): Promise<Answer<T>> => {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<T>()
    pick.title = options.title
    pick.placeholder = options.placeHolder
    pick.step = options.step
    pick.totalSteps = options.totalSteps
    pick.ignoreFocusOut = true
    pick.items = [...items]
    if ((options.step ?? 1) > 1) {
      pick.buttons = [vscode.QuickInputButtons.Back]
    }

    let answered = false
    const finish = (answer: Answer<T>) => {
      answered = true
      resolve(answer)
      pick.hide()
    }
    if (options.freeText) {
      const base = [...items]
      pick.onDidChangeValue((value) => {
        const extra = options.freeText?.(value)
        pick.items = extra ? [extra, ...base] : base
      })
    }
    pick.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish(BACK)
      }
    })
    pick.onDidAccept(() => {
      const [selected] = pick.selectedItems
      if (selected) {
        finish(selected)
      }
    })
    // Fires for `esc` and for a real hide alike, so it must not clobber an answer already resolved.
    pick.onDidHide(() => {
      if (!answered) {
        resolve(CANCEL)
      }
      pick.dispose()
    })
    // After the change handler is registered: assigning `value` fires it, and the free-text
    // row has to be computed against the prefill rather than an empty box.
    if (options.value) {
      pick.value = options.value
    }
    // …and the active row after *that*: reassigning `items` resets the cursor to the first.
    if (options.activeItem) {
      pick.activeItems = [options.activeItem]
    }
    pick.show()
  })
}
