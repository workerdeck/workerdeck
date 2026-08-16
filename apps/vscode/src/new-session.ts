import * as vscode from 'vscode'
import type {
  HostFileRoot,
  ModelOption,
  PermissionMode,
  ProfileInfo,
  SdkSessionSummary,
  SessionInfo,
} from '@workerdeck/protocol'
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
 * Three steps: adapter, working folder, model. Each is skipped when it has
 * nothing to ask (one adapter, no candidate folder, no model catalog), and each
 * can be backed out of, so the sequence never traps you two picks deep.
 *
 * Every step arrives already answered wherever it can be — the folder from this
 * window, the model and the permission mode from the session this adapter ran
 * last — so the flow is `enter, enter, enter` unless you want something else.
 * That is also why the permission mode is not a fourth step: see `resolveMode`.
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
        : await pickModelAndCreate(deps, adapter!, cwd!)
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
 * always means one of them, so these lead unconditionally), recent session cwds,
 * and — the only *authoritative* source — the roots the gateway itself will
 * accept. The first three are all inferred from this window, so a remote gateway
 * with no sessions yet would otherwise have only a guess: asking the gateway is
 * what makes the step trustworthy there, and what gives it a browse.
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
  // `verified` = this gateway is known to be able to chdir here, as opposed to a
  // path inferred from this window that it may or may not share. It decides the
  // *preset* only; every candidate is offered either way.
  const candidates: { path: string; hint: string; verified: boolean }[] = []
  const add = (path: string, hint: string, verified: boolean) => {
    if (path && !candidates.some((c) => c.path === path)) candidates.push({ path, hint, verified })
  }

  // Asked FIRST, because it is the only authoritative answer and everything
  // below wants to know it: where the gateway will let a session live. An absent
  // route (host files not configured) is a 404 — a fine answer, not an error.
  const roots = await hostRoots(deps, host)
  const underRoot = (path: string) =>
    roots.some((r) => path === r.path || path.startsWith(r.path.endsWith('/') ? r.path : `${r.path}/`))

  if (current) add(current, 'chosen', true)
  // The window's folders LEAD, always. Starting a session from an editor almost
  // always means "here", and that has to hold even when the gateway is reached
  // by a LAN name or a tailnet address rather than loopback — which is the
  // common dev setup, and where this step used to fall through to the newest
  // session's cwd and offer `~/projects` to someone sitting in
  // `~/projects/ai/workerdeck`.
  //
  // Leading the list is not the same as being the *preset*, and the difference
  // is what keeps a genuinely remote gateway working: prefilling the input with
  // a local path that does not exist there is worse than it sounds, because the
  // create failure surfaces as a toast *after* the flow has already returned —
  // folder, model and all — so the whole sequence has to be walked again.
  //
  // So `local` no longer filters, it decides `verified` — and it is not the only
  // thing that can: a folder **inside one of the gateway's own roots** is
  // verified whoever it belongs to, which is exactly the LAN-address gateway
  // that really is this machine. A remote gateway's roots will not contain a
  // local path, so there it stays a guess and the preset moves on.
  //
  // A `workerdeck://` mount is the one case that stays filtered out: it names
  // its gateway, so another gateway's mount is positively known to be a
  // different machine's directory rather than merely unverified.
  for (const root of workspaceScope()?.roots ?? []) {
    if (root.hostId) {
      if (root.hostId.toLowerCase() === host.id.toLowerCase()) add(root.path, 'this window', true)
    } else if (host.local || underRoot(root.path)) {
      add(root.path, 'this window', true)
    } else {
      add(root.path, `this window · unverified on ${host.name}`, false)
    }
  }
  // Computed under the same local-vs-remote rule, so it is only ever set when it
  // is a path this gateway shares.
  add(host.cwdSuggestion ?? '', 'suggested', true)
  // A session actually ran here, which is the strongest evidence there is.
  for (const info of deps.state().sessions[host.id] ?? []) add(info.cwd, 'recent session', true)
  for (const root of roots) add(root.path, 'on the gateway', true)

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

  // The default is normally the window's own folder, and it arrives **in the
  // input**, not merely highlighted in the list: this step is a path, people
  // expect to see the path, and an empty box next to "type an absolute path"
  // reads as unanswered. Prefilled it is also immediately editable — adjusting a
  // subdirectory is a few keystrokes rather than retyping the whole thing.
  //
  // The first *verified* candidate, though, not simply the first: an unverified
  // row is a guess worth offering and not one worth pre-answering with. In the
  // ordinary case (loopback gateway, or a folder inside the gateway's roots) the
  // window's folder is verified and still wins, because it is first.
  const preset = current ?? (candidates.find((c) => c.verified) ?? candidates[0])?.path
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

/**
 * The session this adapter ran last, newest first — where the model and
 * permission mode a new session starts on come from.
 *
 * Read back off the gateway's own session list rather than remembered in
 * `globalState` at create time, and that is the whole point: an operator who
 * switched model or mode *during* a session did so through the in-session
 * pickers, and a stored copy of what they asked for at creation would not know
 * it. The list is also per gateway and survives a window reload for free.
 *
 * Matched on the profile as well as the host, because a model id means nothing
 * to another engine — resuming codex's last model into a claude session would
 * name a model the engine has never heard of.
 */
function lastSessionOf(deps: NewSessionDeps, adapter: AdapterChoice): SessionInfo | undefined {
  const engine = adapter.profile.engine ?? 'claude'
  return (
    (deps.state().sessions[adapter.host.id] ?? [])
      .filter((s) =>
        // `SessionInfo.profile` is the RESOLVED name and is present even when
        // the create call left it implicit, so it is the precise test whenever
        // the session reports one — comparing it against the engine would miss
        // a single-profile gateway whose profile is not named after its engine.
        // Engine is the fallback for an older server that reports neither.
        s.profile !== undefined ? s.profile === adapter.profile.name : (s.engine ?? 'claude') === engine,
      )
      // The gateway's list order is its own business; recency is the question
      // being asked here.
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))[0]
  )
}

/**
 * Step 3 of a create: which model, then the create itself.
 *
 * It replaced the "first prompt" step, which was the wrong question to end on:
 * interactively you are about to be looking at a composer, and a prompt typed
 * into a QuickPick is a prompt typed without the transcript in front of you.
 * (It was also load-bearing for a real bug — a woken session re-ran
 * `config.prompt` — so the surface is smaller for its absence.)
 *
 * Model is the question worth asking here because it is the one thing that is
 * awkward to change after the fact and cheap to answer before: it arrives
 * preselected on whatever the last session used, so `enter` is the whole
 * interaction unless you want something else. The permission *mode* deliberately
 * stays out of the flow — see `resolveMode`.
 */
async function pickModelAndCreate(
  deps: NewSessionDeps,
  adapter: AdapterChoice,
  cwd: string,
): Promise<Answer<void>> {
  const previous = lastSessionOf(deps, adapter)
  const mode = resolveMode(adapter, previous)
  const models = adapter.profile.models ?? []
  // Nothing to ask: a profile whose engine ships no catalog answers for itself
  // rather than showing a one-row pick or an empty one.
  if (models.length === 0) {
    await create(deps, adapter, { cwd, permissionMode: mode })
    return undefined
  }

  // Only the last session's OWN model preselects a catalog row. A profile
  // default is deliberately NOT resolved to whichever row happens to equal it:
  // it has a row of its own below, and "unset" is a different request from
  // "this id" — the gateway fills an unset model from the profile, and for
  // claude that is the operator's CLI config, which no catalog row can name.
  const preferred = previous?.model
  const isPreferred = (m: ModelOption) =>
    preferred !== undefined && (m.value === preferred || m.resolvedModel === preferred)
  // `value: undefined` is the sentinel row protocol assigns to clients —
  // catalogs never carry one (see ModelOption's docs), and every other client
  // adds it. Without it this flow could not create a session on the profile's
  // own default at all: it would send whichever row the cursor happened to land
  // on, which for claude is the newest and most expensive model in the catalog.
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
      // Only worth saying when it is the session's own history — "last used"
      // about a model nobody here has run is a claim, not a hint.
      description: isPreferred(m) ? 'last used' : undefined,
      detail: m.description ?? m.resolvedModel,
      value: m.value,
    })),
    fallbackRow,
  ]
  const picked = await showPick(items, {
    title: 'New session: model',
    placeHolder: `Model for this session — permission mode: ${modeLabel(mode)}`,
    // The profile's default whenever the last session's model is unknown or has
    // since left the catalog (a model can be retired between one session and the
    // next). Never the catalog's first row by accident.
    activeItem: items[models.findIndex(isPreferred)] ?? fallbackRow,
    step: 3,
    totalSteps: 3,
  })
  if (picked === CANCEL) return CANCEL
  if (picked === BACK) return BACK
  await create(deps, adapter, { cwd, model: picked.value, permissionMode: mode })
  return undefined
}

/**
 * The permission mode a new session starts in — a default, never a step.
 *
 * Two questions in a row is one too many for a flow whose whole point is that
 * `enter` gets you a session, and mode is the one people set once and keep: so
 * it follows the last session by default, and `workerdeck.newSession.permissionMode`
 * is the way to pin it — which is what "always start on Auto" needs, without
 * costing everyone a pick.
 *
 * Clamped to what the engine admits either way. A mode carried over from a
 * claude session (or typed into the setting years ago) that this engine does
 * not have is dropped rather than sent: the gateway would refuse the create,
 * and the profile's own default is a better answer than an error.
 */
function resolveMode(
  adapter: AdapterChoice,
  previous: SessionInfo | undefined,
): PermissionMode | undefined {
  const pinned = vscode.workspace
    .getConfiguration('workerdeck')
    .get<string>('newSession.permissionMode', 'remember')
  const wanted =
    pinned && pinned !== 'remember'
      ? (pinned as PermissionMode)
      : (previous?.permissionMode ?? adapter.profile.defaults?.permissionMode)
  if (!wanted) return undefined
  // The profile's OWN record, not the static table keyed by engine: the gateway
  // serves it from the first request and it is what the create call is actually
  // checked against.
  const caps = adapter.profile.capabilities ?? ENGINE_CAPABILITIES[adapter.profile.engine ?? 'claude']
  return caps.permissionModes.includes(wanted) ? wanted : undefined
}

function modeLabel(mode: PermissionMode | undefined): string {
  // 'default' is spelled "Manual" everywhere a person reads it (see
  // PERMISSION_MODES in ui) — the wire name would read as "the default", which
  // is the opposite of what it means.
  if (mode === undefined || mode === 'default') return 'Manual'
  if (mode === 'acceptEdits') return 'Accept edits'
  if (mode === 'bypassPermissions') return 'Bypass'
  if (mode === 'dontAsk') return "Don't ask"
  return mode.charAt(0).toUpperCase() + mode.slice(1)
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
    // A resume is a session created from VS Code too, which is what the setting
    // says it governs — and the thread being resumed carries no mode of its own,
    // so leaving it unset would silently ignore a pinned "always Auto" for
    // exactly the sessions most likely to want it. Model stays unset: the thread
    // already has one, and this flow never asked.
    permissionMode: resolveMode(adapter, lastSessionOf(deps, adapter)),
  })
  return undefined
}

async function create(
  deps: NewSessionDeps,
  adapter: AdapterChoice,
  body: {
    cwd: string
    resume?: string
    title?: string
    model?: string
    permissionMode?: PermissionMode
  },
): Promise<void> {
  const client = await clientFor(deps.store, adapter.host)
  if (!client) return
  // Say the mode out loud whenever it is not the asking one. The model step's
  // placeholder already does, but a profile with no catalog skips that step
  // entirely and creates straight off the folder — so a `bypassPermissions`
  // inherited from the last session would otherwise reach a running session
  // without ever having been shown.
  const modeNote =
    body.permissionMode && body.permissionMode !== 'default'
      ? ` · ${modeLabel(body.permissionMode)}`
      : ''
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
          // The CLI only allows bypass when the process was spawned for it, so
          // it is decided here or never — asking for the mode without this flag
          // is asking for a switch the engine will refuse.
          allowDangerouslySkipPermissions:
            body.permissionMode === 'bypassPermissions' ? true : undefined,
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

