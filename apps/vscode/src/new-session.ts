import * as vscode from 'vscode'
import type { HostFileRoot, ProfileInfo, SdkSessionSummary } from '@workerdeck/protocol'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import type { SidebarState, WireHost } from './bridge-protocol.ts'
import { workspaceScope } from './workspace-scope.ts'

/**
 * Creating and resuming a session, as native multi-step QuickPicks.
 *
 * This used to be a form the Sessions view pushed over itself, and it was the
 * last thing in this extension that navigated anywhere: killing it is what lets
 * that view be nothing but a list, with no screen state, no title to retitle and
 * no back chevron to contribute. A QuickPick is also simply the right shape —
 * it is modal, `esc` always means cancel, and it is where VS Code puts every
 * other "pick some things and go" flow it ships.
 *
 * Three steps: adapter, working folder, optional first prompt. Each is skipped
 * when it has nothing to ask (one adapter, no candidate folder), and each can be
 * backed out of, so the sequence never traps you two picks deep.
 */

/** One adapter the operator could run, on one gateway. */
type AdapterChoice = {
  host: WireHost
  profile: ProfileInfo
  /**
   * Whether to name the profile on the create call. A gateway with exactly one
   * profile resolves it implicitly, and saying so explicitly is a difference
   * the old form was careful not to introduce.
   */
  explicit: boolean
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

export async function createSession(deps: NewSessionDeps): Promise<void> {
  await run(deps, { resume: false })
}

/**
 * Resume, on the same rails. It was a section of the old form, and it stays a
 * flow of its own rather than a fourth step: everything up to the folder is
 * identical, and then the question is which stored session — not what to say to
 * a new one. Only engines whose sessions are on disk and browsable can offer it.
 */
export async function resumeSession(deps: NewSessionDeps): Promise<void> {
  await run(deps, { resume: true })
}

async function run(deps: NewSessionDeps, options: { resume: boolean }): Promise<void> {
  const adapters = await loadAdapters(deps)
  if (adapters === undefined) return
  if (adapters.length === 0) {
    void vscode.window.showInformationMessage(
      'WorkerDeck: no gateway is reachable. Add one in the Gateways view.',
    )
    return
  }

  // A plain step index, walked forwards on an answer and backwards on the back
  // button. Steps that have nothing to ask answer for themselves, which is also
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
      if (picked === CANCEL) return
      // Nothing before the first step, so its back button is never shown.
      if (picked === BACK) return
      adapter = picked
      step = 1
    } else if (step === 1) {
      const picked = await pickFolder(deps, adapter!, cwd)
      if (picked === CANCEL) return
      if (picked === BACK) {
        // Straight past a step that never asked, or there is nothing to go back to.
        if (adapters.length === 1) return
        step = 0
        continue
      }
      cwd = picked
      step = 2
    } else {
      const done = options.resume
        ? await pickAndResume(deps, adapter!, cwd!)
        : await askPromptAndCreate(deps, adapter!, cwd!)
      if (done === BACK) {
        step = 1
        continue
      }
      return
    }
  }
}

/**
 * Every adapter on every reachable gateway, flattened. Flattened because the
 * choice a person is making is "claude or codex", not "which gateway, then which
 * profile" — with one gateway configured the gateway never comes up at all, and
 * with several it rides along as the row's detail instead of costing a step.
 */
async function loadAdapters(deps: NewSessionDeps): Promise<AdapterChoice[] | undefined> {
  const hosts = deps.state().hosts.filter((h) => h.probe === 'connected')
  if (hosts.length === 0) return []
  const choices = await vscode.window.withProgress(
    { location: { viewId: 'workerdeck.sessions' }, title: 'Loading adapters…' },
    async () => {
      const perHost = await Promise.all(
        hosts.map(async (host) => {
          const client = await clientFor(deps.store, host)
          if (!client) return []
          try {
            const { profiles } = await client.listProfiles()
            return profiles.map((profile) => ({
              host,
              profile,
              explicit: profiles.length > 1,
            }))
          } catch {
            // A gateway that answered a poll can still fail this call; the others
            // are still worth offering, so it drops out rather than failing all.
            return []
          }
        }),
      )
      return perHost.flat()
    },
  )
  // Available first — an adapter whose credentials are missing stays pickable
  // (the reason is on the row) but should not be what the cursor lands on.
  return choices.sort(
    (a, b) => Number(a.profile.available === false) - Number(b.profile.available === false),
  )
}

type AdapterItem = vscode.QuickPickItem & { choice: AdapterChoice }

async function pickAdapter(
  adapters: readonly AdapterChoice[],
  current: AdapterChoice | undefined,
): Promise<Answer<AdapterChoice>> {
  const multiGateway = new Set(adapters.map((a) => a.host.id)).size > 1
  const items: AdapterItem[] = adapters.map((choice) => {
    const engine = choice.profile.engine ?? 'claude'
    return {
      label: choice.profile.available === false ? `$(warning) ${engine}` : engine,
      // The profile name only earns a slot when it is not just the engine again.
      description: [
        choice.profile.name === engine ? undefined : choice.profile.name,
        multiGateway ? choice.host.name : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      detail:
        choice.profile.available === false
          ? (choice.profile.unavailableReason ?? 'credentials look unavailable')
          : undefined,
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
 * The working folder, prefilled and editable.
 *
 * Candidates come from four places, best first: whatever was chosen before a
 * back-step, the window's own folders (a session started from an editor almost
 * always means one of them), recent session cwds, and — the only *authoritative*
 * source — the roots the gateway itself will accept. The first three are all
 * inferred from this window and all gated on the gateway being loopback, so a
 * remote gateway with no sessions yet had none of them: no rows, no browse, and
 * an empty box. Asking the gateway is what makes the step work at all there.
 *
 * A typed path stays available throughout, since a listing can be refused or
 * truncated and the operator may know a path the routes will accept anyway.
 */
async function pickFolder(
  deps: NewSessionDeps,
  adapter: AdapterChoice,
  current: string | undefined,
): Promise<Answer<string>> {
  const host = adapter.host
  const candidates: { path: string; hint: string }[] = []
  const add = (path: string, hint: string) => {
    if (path && !candidates.some((c) => c.path === path)) candidates.push({ path, hint })
  }

  if (current) add(current, 'chosen')
  // The window's folders, but only those this gateway could actually chdir into
  // — a remote gateway's identical-looking path is another machine's directory.
  // Same rule the sessions list scopes by.
  for (const root of workspaceScope()?.roots ?? []) {
    const usable = root.hostId ? root.hostId.toLowerCase() === host.id.toLowerCase() : host.local
    if (usable) add(root.path, 'this window')
  }
  add(host.cwdSuggestion ?? '', 'suggested')
  for (const info of deps.state().sessions[host.id] ?? []) add(info.cwd, 'recent session')
  // Ask the GATEWAY where it will let a session live. Everything above is
  // inferred from this window, and every bit of it is gated on the gateway being
  // loopback — so for a remote gateway with no sessions yet this step used to
  // offer nothing at all: no rows, no browse, and an empty box under "type an
  // absolute path". These roots are authoritative instead of inferred, and they
  // exist on both kinds of gateway. Absent route (host files not configured) is
  // a 404, which is a fine answer and not an error.
  const roots = await hostRoots(deps, host)
  for (const root of roots) add(root.path, 'on the gateway')

  // Last resort: a remote gateway that exposes no filesystem and has run nothing
  // yet leaves every source above empty, and an empty box under "type an absolute
  // path" is the worst version of this step — it asks the operator to recall a
  // path exactly, with no way to check it. So the window's folders are offered
  // anyway, as a starting point to edit rather than a claim: a gateway reached by
  // hostname may well be this same machine, and where it isn't, the path is still
  // the right shape and usually the right project name. The hint says plainly
  // that it is a guess, and a cwd that does not exist fails the create call
  // cleanly — this cannot do damage, only save typing.
  if (candidates.length === 0) {
    for (const root of workspaceScope()?.roots ?? []) {
      add(root.path, `unverified on ${host.name}`)
    }
  }

  type FolderItem = vscode.QuickPickItem & { path?: string; browse?: boolean }
  const items: FolderItem[] = candidates.map((c) => ({
    label: c.path,
    description: c.hint,
    iconPath: new vscode.ThemeIcon('folder'),
    path: c.path,
    // The input arrives prefilled (see `value` below), which would otherwise
    // filter this list down to the one row matching it — so every candidate
    // opts out of filtering. Editing the path still narrows nothing away that
    // someone might want instead.
    alwaysShow: true,
  }))
  // Browsing: the native dialog for a gateway on this machine, and for a remote
  // one a walk over its own `/fs/list`. Remote used to get nothing here, which
  // is exactly the case where guessing a path is hardest.
  if (host.local || roots.length > 0) {
    items.push({
      label: 'Browse…',
      description: host.local ? undefined : `on ${host.name}`,
      iconPath: new vscode.ThemeIcon('folder-opened'),
      browse: true,
      alwaysShow: true,
    })
  }

  // The default is the window's own folder, and it arrives **in the input**, not
  // merely highlighted in the list: this step is a path, people expect to see the
  // path, and an empty box next to "type an absolute path" reads as unanswered.
  // Prefilled it is also immediately editable — adjusting a subdirectory is a few
  // keystrokes rather than retyping the whole thing.
  const preset = current ?? candidates[0]?.path
  const picked = await showPick(items, {
    title: 'New session: working folder',
    placeHolder: host.local
      ? 'Pick a folder, or type an absolute path'
      : `Pick a folder on ${host.name}, or type an absolute path`,
    value: preset,
    activeItem: items.find((i) => i.path === preset),
    step: 2,
    totalSteps: 3,
    // Anything typed is a candidate path in its own right — the list cannot
    // enumerate a remote filesystem, so the text box is the fallback that always
    // works. Absolute only, which is the same rule the old form enforced.
    freeText: (value) =>
      // A value that IS one of the candidates needs no row of its own; without
      // this the prefilled path would appear twice on open.
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
  if (picked === CANCEL || picked === BACK) return picked
  if (picked.browse) {
    const chosen = host.local
      ? await browseLocally(candidates[0]?.path)
      : await browseGateway(deps, host, roots)
    // Cancelling the browse returns to this step rather than dropping the flow.
    if (!chosen) return pickFolder(deps, adapter, current)
    return chosen
  }
  return picked.path!
}

/** Where this gateway will let a session live, or nothing if it does not say
 * (the `/fs/*` routes are absent when no roots are configured — a 404, not a
 * failure, and not worth a message). */
async function hostRoots(deps: NewSessionDeps, host: WireHost): Promise<HostFileRoot[]> {
  const client = await clientFor(deps.store, host)
  if (!client) return []
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

/**
 * Walk a remote gateway's directories over `/fs/list`, one QuickPick per level.
 *
 * There is no native dialog for a filesystem on another machine, and typing an
 * absolute path from memory is the worst part of starting a remote session — so
 * this is the same affordance the local case gets, built from the listing route
 * the workspace file rail already uses. Each level offers its subdirectories,
 * the parent, and "use this folder", which is what makes any level a valid
 * answer rather than only the leaves.
 */
async function browseGateway(
  deps: NewSessionDeps,
  host: WireHost,
  roots: readonly HostFileRoot[],
): Promise<string | undefined> {
  const client = await clientFor(deps.store, host)
  if (!client) return undefined
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
    if (picked === CANCEL || picked === BACK) return undefined
    dir = picked.path
  }

  for (;;) {
    let listing: Awaited<ReturnType<typeof client.listHostDir>>
    try {
      listing = await vscode.window.withProgress(
        { location: { viewId: 'workerdeck.sessions' }, title: 'Listing…' },
        () => client.listHostDir(dir!),
      )
    } catch (err) {
      void vscode.window.showErrorMessage(`WorkerDeck: cannot list ${dir} — ${message(err)}`)
      return undefined
    }
    // Only directories can be a cwd, and a symlink's target is the next
    // request's problem — the route refuses one escaping the roots anyway.
    const dirs = listing.entries.filter((e) => e.type === 'dir' || e.type === 'symlink')
    const parent = listing.path.replace(/\/[^/]+\/*$/, '') || '/'
    // `..` only below a root: at a root there is nowhere legal to go up to, and
    // the route would refuse the request anyway.
    const atRoot = roots.some((r) => r.path === listing.path)

    type Entry = vscode.QuickPickItem & { path?: string; use?: boolean }
    const items: Entry[] = [
      { label: 'Use this folder', description: listing.path, use: true, alwaysShow: true },
      ...(atRoot || parent === listing.path
        ? []
        : [{ label: '..', description: parent, path: parent, alwaysShow: true }]),
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
    if (picked === CANCEL || picked === BACK) return undefined
    if (picked.use) return listing.path
    dir = picked.path!
  }
}

/** Step 3 of a create: the optional first prompt, then the create itself. */
async function askPromptAndCreate(
  deps: NewSessionDeps,
  adapter: AdapterChoice,
  cwd: string,
): Promise<Answer<void>> {
  const prompt = await showInput({
    title: 'New session: first prompt',
    placeHolder: 'Sent as soon as the session starts — leave empty to start idle',
    step: 3,
    totalSteps: 3,
  })
  if (prompt === CANCEL) return CANCEL
  if (prompt === BACK) return BACK
  await create(deps, adapter, { cwd, prompt: prompt.trim() || undefined })
  return undefined
}

/** Step 3 of a resume: which stored session to continue. */
async function pickAndResume(
  deps: NewSessionDeps,
  adapter: AdapterChoice,
  cwd: string,
): Promise<Answer<void>> {
  const caps =
    adapter.profile.capabilities ?? ENGINE_CAPABILITIES[adapter.profile.engine ?? 'claude']
  if (!caps.listSessions) {
    void vscode.window.showInformationMessage(
      `WorkerDeck: ${adapter.profile.engine ?? 'claude'} cannot list stored sessions.`,
    )
    return undefined
  }
  const client = await clientFor(deps.store, adapter.host)
  if (!client) return undefined

  let stored: SdkSessionSummary[]
  try {
    stored = await vscode.window.withProgress(
      { location: { viewId: 'workerdeck.sessions' }, title: 'Loading sessions…' },
      // Named so the gateway lists the CHOSEN profile's engine store — another
      // engine's ids mean nothing to this one.
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
  if (picked === CANCEL) return CANCEL
  if (picked === BACK) return BACK
  await create(deps, adapter, {
    // A stored session knows its own directory; trust it over the pick.
    cwd: picked.stored.cwd ?? cwd,
    resume: picked.stored.sessionId,
    // Adopt the name the engine already knows this thread by — the same string
    // the pick was labelled with. Without it a resumed session is titleless:
    // `meta.title` is unset and the derived fallback reads the first prompt,
    // which a resume deliberately does not send.
    title: (picked.stored.customTitle ?? picked.stored.summary).trim() || undefined,
  })
  return undefined
}

async function create(
  deps: NewSessionDeps,
  adapter: AdapterChoice,
  body: { cwd: string; prompt?: string; resume?: string; title?: string },
): Promise<void> {
  const client = await clientFor(deps.store, adapter.host)
  if (!client) return
  try {
    const info = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'WorkerDeck: creating session…' },
      () =>
        client.createSession({
          cwd: body.cwd,
          profile: adapter.explicit ? adapter.profile.name : undefined,
          // The engine replays the thread it is resuming — a first prompt on top
          // of that would be a second turn nobody asked for.
          prompt: body.resume ? undefined : body.prompt,
          resume: body.resume,
          // `meta.title` is what SessionInfo.title prefers; a rename later
          // overwrites it through the same field.
          meta: body.title ? { title: body.title } : undefined,
        }),
    )
    await deps.refresh()
    await deps.reveal(adapter.host.id, info.id)
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not create the session — ${message(err)}`)
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `showQuickPick` with a back button and an optional free-text row — neither of
 * which the convenience wrapper can do, so this drives `createQuickPick`
 * directly. Resolves to the pick, `BACK`, or `CANCEL`.
 */
function showPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: {
    title: string
    placeHolder: string
    activeItem?: T
    /** Prefill the filter box — a step whose answer is text people expect to
     * arrive already answered and editable. Items must set `alwaysShow` or a
     * prefilled value will filter them all away. */
    value?: string
    step?: number
    totalSteps?: number
    /** Turn whatever is typed into an extra row (a path the list cannot know). */
    freeText?: (value: string) => T | undefined
  },
): Promise<Answer<T>> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<T>()
    pick.title = options.title
    pick.placeholder = options.placeHolder
    pick.step = options.step
    pick.totalSteps = options.totalSteps
    pick.ignoreFocusOut = true
    pick.items = [...items]
    // Shown only where there is something to go back to.
    if ((options.step ?? 1) > 1) pick.buttons = [vscode.QuickInputButtons.Back]

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
      if (button === vscode.QuickInputButtons.Back) finish(BACK)
    })
    pick.onDidAccept(() => {
      const [selected] = pick.selectedItems
      if (selected) finish(selected)
    })
    // Fires for `esc` and for a real hide alike, so it must not clobber an
    // answer the accept/button handlers have already resolved.
    pick.onDidHide(() => {
      if (!answered) resolve(CANCEL)
      pick.dispose()
    })
    // Deliberately after the change handler is registered: assigning `value`
    // fires it, and the free-text row has to be computed against the prefill
    // rather than against an empty box.
    if (options.value) pick.value = options.value
    // …and the active row after *that*, because reassigning `items` (which the
    // change handler just did) resets the cursor to the first one.
    if (options.activeItem) pick.activeItems = [options.activeItem]
    pick.show()
  })
}

/** `showInputBox` with a back button. Empty input is a valid answer here — the
 * first prompt is optional — so this cannot lean on validation to mean "unset". */
function showInput(options: {
  title: string
  placeHolder: string
  step?: number
  totalSteps?: number
}): Promise<Answer<string>> {
  return new Promise((resolve) => {
    const input = vscode.window.createInputBox()
    input.title = options.title
    input.placeholder = options.placeHolder
    input.step = options.step
    input.totalSteps = options.totalSteps
    input.ignoreFocusOut = true
    if ((options.step ?? 1) > 1) input.buttons = [vscode.QuickInputButtons.Back]

    let answered = false
    const finish = (answer: Answer<string>) => {
      answered = true
      resolve(answer)
      input.hide()
    }
    input.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) finish(BACK)
    })
    input.onDidAccept(() => finish(input.value))
    input.onDidHide(() => {
      if (!answered) resolve(CANCEL)
      input.dispose()
    })
    input.show()
  })
}
