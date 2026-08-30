/**
 * Creating and resuming a session, as native multi-step QuickPicks.
 *
 * Three steps: adapter, working folder, model. Each is skipped when it has nothing
 * to ask (one adapter, no candidate folder, no model catalog) and each can be backed
 * out of, so the sequence never traps you two picks deep. Every step arrives already
 * answered wherever it can be, so the flow is `enter, enter, enter`. The permission
 * mode is a default rather than a fourth step — see `resolveMode`.
 */

import * as vscode from 'vscode'
import type { HostFileRoot, ModelOption, PermissionMode, ProfileInfo, SdkSessionSummary, SessionInfo } from '@workerdeck/protocol'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'
import { workspaceScope } from './workspace-scope.ts'

/** One adapter the operator could run, on one gateway. */
type AdapterChoice = {
  host: WireHost
  profile: ProfileInfo
  /** Whether to name the profile on the create call. A gateway with exactly one
   * profile resolves it implicitly. */
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
  /** Prefill the filter box. Items must set `alwaysShow`, or a prefilled value
   * filters them all away. */
  value?: string
  step?: number
  totalSteps?: number
  /** Turn whatever is typed into an extra row (a path the list cannot know). */
  freeText?: (value: string) => T | undefined
}

export type NewSessionDeps = {
  store: HostStore
  state: () => SidebarState
  /** Show the created session in the agent panel. */
  reveal: (hostId: string, sessionId: string) => Promise<void>
  /** Pick up the new session in the list. */
  refresh: () => Promise<void>
}

/** `esc` at any step. Distinct from `'back'`, which reopens the step before. */
const CANCEL = Symbol('cancel')
const BACK = Symbol('back')
type Answer<T> = T | typeof CANCEL | typeof BACK

export const createSession = async (deps: NewSessionDeps): Promise<void> => {
  await run(deps, { resume: false })
}

/**
 * Resume, on the same rails: everything up to the folder is identical, and then the
 * question is which stored session. Only engines whose sessions are on disk and
 * browsable can offer it.
 */
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

  // A plain step index. Steps that have nothing to ask answer for themselves, which is
  // what makes going back past them land on the last real question.
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
      // Nothing before the first step, so its back button is never shown.
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
        // Straight past a step that never asked, or there is nothing to go back to.
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

/**
 * Every adapter on every reachable gateway, flattened: the choice a person is making
 * is "claude or codex", not "which gateway, then which profile", so the gateway
 * rides along as the row's detail instead of costing a step.
 */
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
            // A gateway that answered a poll can still fail this call; the others still count.
            return []
          }
        }),
      )
      return perHost.flat()
    },
  )
  // Available first: a credential-less adapter stays pickable but is not where the cursor lands.
  return choices.sort((a, b) => Number(a.profile.available === false) - Number(b.profile.available === false))
}

type AdapterItem = vscode.QuickPickItem & { choice: AdapterChoice }

const pickAdapter = async (adapters: readonly AdapterChoice[], current: AdapterChoice | undefined): Promise<Answer<AdapterChoice>> => {
  const multiGateway = new Set(adapters.map((a) => a.host.id)).size > 1
  const items: AdapterItem[] = adapters.map((choice) => {
    const engine = choice.profile.engine ?? 'claude'
    return {
      label: choice.profile.available === false ? `$(warning) ${engine}` : engine,
      // The profile name only earns a slot when it is not just the engine again.
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
    // Only from a re-entry via back; a first pass has nothing to restore.
    activeItem: items.find((i) => i.choice === current),
    step: 1,
    totalSteps: 3,
  })
  return picked === CANCEL || picked === BACK ? picked : picked.choice
}

/**
 * The working folder, prefilled and editable. Candidates come from four places, best
 * first: whatever was chosen before a back-step, the window's own folders (which
 * lead unconditionally), recent session cwds, and — the only *authoritative* source
 * — the roots the gateway itself will accept. A typed path stays available
 * throughout, a listing being refusable and the operator possibly knowing better.
 */
const pickFolder = async (deps: NewSessionDeps, adapter: AdapterChoice, current: string | undefined): Promise<Answer<string>> => {
  const host = adapter.host
  // `verified` = this gateway is known to be able to chdir here, as opposed to a path
  // inferred from this window. It decides the *preset* only; every candidate is offered.
  const candidates: { path: string; hint: string; verified: boolean }[] = []
  const add = (path: string, hint: string, verified: boolean) => {
    if (path && !candidates.some((c) => c.path === path)) {
      candidates.push({ path, hint, verified })
    }
  }

  // Asked first, because everything below wants to know it. An absent route (host files
  // not configured) is a 404 — a fine answer, not an error.
  const roots = await hostRoots(deps, host)
  const underRoot = (path: string) => roots.some((r) => path === r.path || path.startsWith(r.path.endsWith('/') ? r.path : `${r.path}/`))

  if (current) {
    add(current, 'chosen', true)
  }
  // The window's folders LEAD unconditionally — starting a session from an editor
  // almost always means "here", including when the gateway is reached by a LAN or
  // tailnet address rather than loopback. Leading is not the same as being the
  // *preset*: `local` decides `verified`, and so does being inside one of the
  // gateway's own roots. A `workerdeck://` mount is the one case filtered out — it
  // names its gateway, so another gateway's mount is positively another machine's.
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
  // Computed under the same local-vs-remote rule, so it is only set for a path this gateway shares.
  add(host.cwdSuggestion ?? '', 'suggested', true)
  // A session actually ran here, which is the strongest evidence there is.
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
    // The input arrives prefilled (see `value` below), which would otherwise filter this
    // list down to the one row matching it — so every candidate opts out of filtering.
    alwaysShow: true,
  }))
  // The native dialog for a gateway on this machine, a walk over `/fs/list` for a remote one.
  if (host.local || roots.length > 0) {
    items.push({
      label: 'Browse…',
      description: host.local ? undefined : `on ${host.name}`,
      iconPath: new vscode.ThemeIcon('folder-opened'),
      browse: true,
      alwaysShow: true,
    })
  }

  // The default arrives **in the input**, not merely highlighted: this step is a path,
  // and prefilled it is immediately editable. The first *verified* candidate, not
  // simply the first — an unverified row is worth offering and not worth pre-answering.
  const preset = current ?? (candidates.find((c) => c.verified) ?? candidates[0])?.path
  const picked = await showPick(items, {
    title: 'New session: working folder',
    placeHolder: host.local ? 'Pick a folder, or type an absolute path' : `Pick a folder on ${host.name}, or type an absolute path`,
    value: preset,
    activeItem: items.find((i) => i.path === preset),
    step: 2,
    totalSteps: 3,
    // Anything typed is a candidate path in its own right: the list cannot enumerate a
    // remote filesystem. Absolute only.
    freeText: (value) =>
      // A value that IS one of the candidates needs no row of its own.
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
    // Cancelling the browse returns to this step rather than dropping the flow.
    if (!chosen) {
      return pickFolder(deps, adapter, current)
    }
    return chosen
  }
  return picked.path!
}

/** Where this gateway will let a session live, or nothing if it does not say
 * (the `/fs/*` routes are absent when no roots are configured — a 404, not a
 * failure, and not worth a message). */
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

/**
 * Walk a remote gateway's directories over `/fs/list`, one QuickPick per level —
 * there is no native dialog for a filesystem on another machine. Each level offers
 * its subdirectories, the parent, and "use this folder", so any level is a valid
 * answer rather than only the leaves.
 */
const browseGateway = async (deps: NewSessionDeps, host: WireHost, roots: readonly HostFileRoot[]): Promise<string | undefined> => {
  const client = await clientFor(deps.store, host)
  if (!client) {
    return undefined
  }
  let dir = roots.length === 1 ? roots[0]!.path : undefined

  // No single root to start from: pick one first.
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
    // Only directories can be a cwd; a symlink's target is the next request's problem.
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

/**
 * The session this adapter ran last — where the model and permission mode a new
 * session starts on come from. Read back off the gateway's own session list rather
 * than remembered at create time, because an operator who switched either one
 * *mid-session* did it through the in-session pickers. Matched on the profile as
 * well as the host: a model id means nothing to another engine.
 */
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

/**
 * Step 3 of a create: which model, then the create itself. Model arrives preselected
 * on whatever the last session used, so `enter` is the whole interaction. There is
 * deliberately **no first-prompt step** (a woken session re-ran `config.prompt`), and
 * the permission mode stays out of the flow — see `resolveMode`.
 */
const pickModelAndCreate = async (deps: NewSessionDeps, adapter: AdapterChoice, cwd: string): Promise<Answer<void>> => {
  const previous = lastSessionOf(deps, adapter)
  const mode = resolveMode(adapter, previous)
  const models = adapter.profile.models ?? []
  // A profile whose engine ships no catalog answers for itself rather than showing an empty pick.
  if (models.length === 0) {
    await create(deps, adapter, { cwd, permissionMode: mode })
    return undefined
  }

  // Only the last session's OWN model preselects a catalog row: "unset" is a different
  // request from "this id", the gateway filling an unset model from the profile.
  const preferred = previous?.model
  const isPreferred = (m: ModelOption) => preferred !== undefined && (m.value === preferred || m.resolvedModel === preferred)
  // `value: undefined` is the sentinel row protocol assigns to clients — catalogs never
  // carry one. Without it this flow could not create a session on the profile's own
  // default at all, and would send whichever row the cursor landed on.
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
      // Only worth saying when it is the session's own history.
      description: isPreferred(m) ? 'last used' : undefined,
      detail: m.description ?? m.resolvedModel,
      value: m.value,
    })),
    fallbackRow,
  ]
  const picked = await showPick(items, {
    title: 'New session: model',
    placeHolder: `Model for this session — permission mode: ${modeLabel(mode)}`,
    // The profile's default whenever the last session's model is unknown or has since left
    // the catalog. Never the catalog's first row by accident.
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

/**
 * The permission mode a new session starts in — a **default, never a step**. It
 * follows the last session, with `workerdeck.newSession.permissionMode` to pin it.
 * Clamped to what the engine admits either way: a mode carried over from another
 * engine would be refused by the gateway, and the profile's default beats an error.
 */
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

/** Step 3 of a resume: which stored session to continue. */
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
    stored = await vscode.window.withProgress(
      { location: { viewId: 'workerdeck.sessions' }, title: 'Loading sessions…' },
      // Named so the gateway lists the CHOSEN profile's engine store; another engine's ids mean nothing.
      () =>
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
    // A stored session knows its own directory; trust it over the pick.
    cwd: picked.stored.cwd ?? cwd,
    resume: picked.stored.sessionId,
    // Adopt the name the engine already knows this thread by: without it a resumed session
    // is titleless, the derived fallback reading a first prompt a resume never sends.
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
  // Say the mode out loud whenever it is not the asking one: a profile with no catalog
  // skips the model step entirely, so an inherited `bypassPermissions` would otherwise
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
          // `meta.title` is what SessionInfo.title prefers; a rename overwrites the same field.
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

/**
 * `showQuickPick` with a back button and an optional free-text row — neither of which
 * the convenience wrapper can do, so this drives `createQuickPick` directly.
 */
const showPick = <T extends vscode.QuickPickItem>(items: readonly T[], options: PickOptions<T>): Promise<Answer<T>> => {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<T>()
    pick.title = options.title
    pick.placeholder = options.placeHolder
    pick.step = options.step
    pick.totalSteps = options.totalSteps
    pick.ignoreFocusOut = true
    pick.items = [...items]
    // Shown only where there is something to go back to.
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
        // The typed row leads: it is the thing being typed.
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
