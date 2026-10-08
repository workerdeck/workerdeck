import * as vscode from 'vscode'
import { ENGINE_CAPABILITIES, errorMessage, newAgentSharing } from '@workerdeck/protocol'
import type { HostFileRoot, PermissionMode, ProfileInfo, SdkSessionSummary, SessionInfo, Sharing } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import { agentDefaultsCached, relayOfCached } from './machine.ts'
import type { HostStore } from './hosts.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'
import { workspaceScope } from './workspace-scope.ts'
import { BACK, CANCEL, showPick, type Answer } from './quick-input.ts'
import { pickModel } from './model-pick.ts'

type NewAgentAnswers = { name?: string; brief?: string; sharing?: Sharing }

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
  agent?: NewAgentAnswers
}

export type NewSessionDeps = {
  store: HostStore
  state: () => SidebarState
  reveal: (hostId: string, sessionId: string) => Promise<void>
  refresh: () => Promise<void>
}

// A preset (a project heading's `+`) pins the gateway and, when it has one, the folder, so those steps are skipped.
export type NewSessionPreset = { hostId: string; cwd?: string }

export async function createSession(deps: NewSessionDeps, preset?: NewSessionPreset): Promise<void> {
  await run(deps, { resume: false, preset })
}

export async function resumeSession(deps: NewSessionDeps): Promise<void> {
  await run(deps, { resume: true })
}

export async function createAgent(deps: NewSessionDeps, preset?: NewSessionPreset): Promise<void> {
  await run(deps, { resume: false, agent: true, preset })
}

async function run(deps: NewSessionDeps, options: { resume: boolean; agent?: boolean; preset?: NewSessionPreset }): Promise<void> {
  const { preset } = options
  const loaded = await loadAdapters(deps)
  if (loaded === undefined) {
    return
  }
  const adapters = preset ? loaded.filter((a) => a.host.id === preset.hostId) : loaded
  if (adapters.length === 0) {
    void vscode.window.showInformationMessage(
      preset ? 'WorkerDeck: that gateway is not reachable.' : 'WorkerDeck: no gateway is reachable. Add one in the Gateways view.',
    )
    return
  }

  let step = 0
  let adapter: AdapterChoice | undefined
  let cwd: string | undefined = preset?.cwd

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
      if (preset?.cwd) {
        step = 2
        continue
      }
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
      const done = options.resume
        ? await pickAndResume(deps, adapter!, cwd!)
        : await pickModelAndCreate(deps, adapter!, cwd!, options.agent === true)
      if (done === BACK) {
        if (preset?.cwd) {
          if (adapters.length === 1) {
            return
          }
          step = 0
          continue
        }
        step = 1
        continue
      }
      return
    }
  }
}

async function loadAdapters(deps: NewSessionDeps): Promise<AdapterChoice[] | undefined> {
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

async function pickAdapter(adapters: readonly AdapterChoice[], current: AdapterChoice | undefined): Promise<Answer<AdapterChoice>> {
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

async function pickFolder(deps: NewSessionDeps, adapter: AdapterChoice, current: string | undefined): Promise<Answer<string>> {
  const host = adapter.host
  const candidates: { path: string; hint: string; verified: boolean }[] = []
  const add = (path: string, hint: string, verified: boolean) => {
    if (path && !candidates.some((c) => c.path === path)) {
      candidates.push({ path, hint, verified })
    }
  }

  // An absent `/fs/*` route (host files not configured) is a 404 - a fine answer, not an error.
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

async function hostRoots(deps: NewSessionDeps, host: WireHost): Promise<HostFileRoot[]> {
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

async function browseLocally(start: string | undefined): Promise<string | undefined> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use folder',
    defaultUri: start ? vscode.Uri.file(start) : undefined,
  })
  return chosen?.[0]?.fsPath
}

async function browseGateway(deps: NewSessionDeps, host: WireHost, roots: readonly HostFileRoot[]): Promise<string | undefined> {
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
      void vscode.window.showErrorMessage(`WorkerDeck: cannot list ${dir} - ${errorMessage(err)}`)
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

function lastSessionOf(deps: NewSessionDeps, adapter: AdapterChoice): SessionInfo | undefined {
  const engine = adapter.profile.engine ?? 'claude'
  return (
    (deps.state().sessions[adapter.host.id] ?? [])
      .filter((s) =>
        // `profile` is the resolved name whenever the gateway has profiles; engine covers one that has none.
        s.profile !== undefined ? s.profile === adapter.profile.name : (s.engine ?? 'claude') === engine,
      )
      // The gateway's list order is its own business; recency is the question here.
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))[0]
  )
}

async function pickModelAndCreate(deps: NewSessionDeps, adapter: AdapterChoice, cwd: string, agent: boolean): Promise<Answer<void>> {
  const previous = lastSessionOf(deps, adapter)
  const mode = resolveMode(adapter, previous)
  const models = adapter.profile.models ?? []
  const noun = agent ? 'agent' : 'session'
  if (models.length === 0) {
    const named = agent ? await askAgent(deps, adapter) : undefined
    if (named === CANCEL) {
      return CANCEL
    }
    await create(deps, adapter, { cwd, permissionMode: mode, agent: named })
    return undefined
  }

  // Only the last session's OWN model preselects a row: "unset" is a different request from "this id", the gateway
  // filling an unset model from the profile, so picking the default row keeps it unset.
  const picked = await pickModel(models, {
    title: `New ${noun}: model`,
    placeHolder: `Model for this ${noun} - permission mode: ${modeLabel(mode)}`,
    defaultModel: adapter.profile.defaultModel,
    current: previous?.model,
    currentTag: 'last used',
    unset: { label: 'Profile default', detail: "whatever the profile's engine is configured for" },
    step: 3,
    totalSteps: 3,
  })
  if (picked === CANCEL) {
    return CANCEL
  }
  if (picked === BACK) {
    return BACK
  }
  const named = agent ? await askAgent(deps, adapter) : undefined
  if (named === CANCEL) {
    return CANCEL
  }
  await create(deps, adapter, { cwd, model: picked.isDefault ? undefined : picked.model?.value, permissionMode: mode, agent: named })
  return undefined
}

// Both answers are optional: a blank name lets the gateway suggest one, a blank brief means none. Sharing is asked
// only where another owner could see the agent at all: a gateway that allows sharing and either dials a relay or
// hosts several owners itself.
async function askAgent(deps: NewSessionDeps, adapter: AdapterChoice): Promise<NewAgentAnswers | typeof CANCEL> {
  const name = await vscode.window.showInputBox({
    title: 'New agent: name',
    prompt: 'Leave empty for a suggested name',
    ignoreFocusOut: true,
  })
  if (name === undefined) {
    return CANCEL
  }
  const brief = await vscode.window.showInputBox({
    title: 'New agent: brief',
    prompt: 'Standing instructions the agent keeps across conversations (optional)',
    ignoreFocusOut: true,
  })
  if (brief === undefined) {
    return CANCEL
  }
  const answers = { name: name.trim() || undefined, brief: brief.trim() || undefined }
  const host = deps.store.get(adapter.host.id)
  const defaults = host ? agentDefaultsCached(host) : undefined
  if (!host || !(relayOfCached(host) || defaults?.multiOwner) || defaults?.allowShared === false) {
    return answers
  }
  const fallback = newAgentSharing(defaults, adapter.profile)
  const items: Array<vscode.QuickPickItem & { sharing: Sharing }> = [
    { label: 'Private', detail: 'Invisible to other owners', sharing: 'private' },
    { label: 'Shared', detail: 'Other owners see a card, and their shared agents can message this one', sharing: 'shared' },
  ]
  const sharing = await vscode.window.showQuickPick(
    items
      .map((item) => (item.sharing === fallback ? { ...item, description: 'default' } : item))
      .sort((a, b) => Number(b.sharing === fallback) - Number(a.sharing === fallback)),
    { title: 'New agent: other owners', ignoreFocusOut: true },
  )
  if (sharing === undefined) {
    return CANCEL
  }
  return { ...answers, sharing: sharing.sharing }
}

function resolveMode(adapter: AdapterChoice, previous: SessionInfo | undefined): PermissionMode | undefined {
  // User-level only, whatever the manifest's scope says: a cloned repo's settings must never start a session on bypass.
  const setting = vscode.workspace.getConfiguration('workerdeck').inspect<string>('newSession.permissionMode')
  const pinned = setting?.globalValue ?? setting?.defaultValue ?? 'remember'
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

function modeLabel(mode: PermissionMode | undefined): string {
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

async function pickAndResume(deps: NewSessionDeps, adapter: AdapterChoice, cwd: string): Promise<Answer<void>> {
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
    void vscode.window.showErrorMessage(`WorkerDeck: ${errorMessage(err)}`)
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

async function create(deps: NewSessionDeps, adapter: AdapterChoice, body: CreateBody): Promise<void> {
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
        title: `WorkerDeck: creating ${body.agent ? 'agent' : 'session'}…${modeNote}`,
      },
      async () => {
        if (body.agent) {
          const created = await client.createAgent({
            name: body.agent.name,
            config: {
              cwd: body.cwd,
              profile: adapter.explicit ? adapter.profile.name : undefined,
              model: body.model,
              permissionMode: body.permissionMode,
              brief: body.agent.brief,
            },
            ...(body.agent.sharing ? { sharing: body.agent.sharing } : {}),
          })
          if (!created.session) {
            throw new Error('the gateway created the agent without a session')
          }
          return created.session
        }
        return await client.createSession({
          cwd: body.cwd,
          profile: adapter.explicit ? adapter.profile.name : undefined,
          resume: body.resume,
          model: body.model,
          permissionMode: body.permissionMode,
          // The CLI only allows bypass when the process was spawned for it: decided here or
          // never, and asking for the mode without this flag is asking to be refused.
          allowDangerouslySkipPermissions: body.permissionMode === 'bypassPermissions' ? true : undefined,
          meta: body.title ? { title: body.title } : undefined,
        })
      },
    )
    await deps.refresh()
    await deps.reveal(adapter.host.id, info.id)
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not create the ${body.agent ? 'agent' : 'session'} - ${errorMessage(err)}`)
  }
}
