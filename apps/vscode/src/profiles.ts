import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProfileEngine, ProfileInfo } from '@workerdeck/protocol'
import type { WorkerDeckClient } from '@workerdeck/client'
import * as vscode from 'vscode'
import { clientFor } from './gateway.ts'
import { isLoopbackHost, type GatewayHost, type HostStore } from './hosts.ts'
import { BACK, CANCEL, showInput, showPick } from './quick-input.ts'

export type ProfileFlowDeps = {
  store: HostStore
  hosts: () => GatewayHost[]
  refresh: () => Promise<void>
}

export async function addProfile(deps: ProfileFlowDeps, hostId?: string): Promise<void> {
  const host = hostId ? deps.store.get(hostId) : await pickHost(deps)
  if (!host) {
    return
  }
  const client = await clientFor(deps.store, host)
  if (client) {
    await create(deps, host, client)
  }
}

export async function editProfile(deps: ProfileFlowDeps, hostId: string, name: string): Promise<void> {
  const host = deps.store.get(hostId)
  if (!host) {
    return
  }
  const client = await clientFor(deps.store, host)
  if (!client) {
    return
  }
  let profile: ProfileInfo
  try {
    profile = (await client.getProfile(name)).profile
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: ${describe(err)}`)
    return
  }
  if (declared(profile, host)) {
    return
  }
  await edit(deps, host, client, profile)
}

export async function removeProfile(deps: ProfileFlowDeps, hostId: string, name: string): Promise<void> {
  const host = deps.store.get(hostId)
  if (!host) {
    return
  }
  const client = await clientFor(deps.store, host)
  if (!client) {
    return
  }
  let profile: ProfileInfo
  try {
    profile = (await client.getProfile(name)).profile
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: ${describe(err)}`)
    return
  }
  if (declared(profile, host)) {
    return
  }
  await confirmDelete(deps, host, client, profile)
}

type EngineChoice = { engine: ProfileEngine; label: string; detail: string; dirPrompt: string; dirDefault: string }

const ENGINES: readonly EngineChoice[] = [
  {
    engine: 'claude',
    label: 'Claude',
    detail: 'The Claude Agent SDK, against a CLAUDE_CONFIG_DIR you name.',
    dirPrompt: 'Config directory for this profile — its CLAUDE_CONFIG_DIR.',
    dirDefault: '~/.claude',
  },
  {
    engine: 'codex',
    label: 'Codex',
    detail: 'The codex app-server, against a CODEX_HOME you name.',
    dirPrompt: 'Home directory for this profile — its CODEX_HOME.',
    dirDefault: '~/.codex',
  },
]

const TOTAL_STEPS = 3

export async function manageProfiles(deps: ProfileFlowDeps): Promise<void> {
  const host = await pickHost(deps)
  if (!host) {
    return
  }
  const client = await clientFor(deps.store, host)
  if (!client) {
    return
  }
  await browse(deps, host, client)
}

async function browse(deps: ProfileFlowDeps, host: GatewayHost, client: WorkerDeckClient): Promise<void> {
  let listed
  try {
    listed = await client.listProfiles()
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not read ${host.name}'s profiles — ${describe(err)}`)
    return
  }
  const items = [
    ...listed.profiles.map((profile) => ({
      label: profile.name,
      description: describeProfile(profile),
      detail: profile.configDir ?? profile.codexHome ?? profile.description,
      profile,
    })),
    ...(listed.canManage ? [{ label: '$(add) New profile…', description: undefined, detail: undefined, profile: undefined }] : []),
  ]
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`WorkerDeck: ${host.name} declares no profiles and does not allow adding any.`)
    return
  }
  const picked = await showPick(items, {
    title: `Profiles — ${host.name}`,
    placeHolder: listed.canManage ? 'Pick a profile to edit, or add one' : 'This gateway serves profiles read-only',
  })
  if (picked === CANCEL || picked === BACK) {
    return
  }
  if (!picked.profile) {
    await create(deps, host, client)
    return
  }
  if (declared(picked.profile, host)) {
    return
  }
  await edit(deps, host, client, picked.profile)
}

async function edit(deps: ProfileFlowDeps, host: GatewayHost, client: WorkerDeckClient, profile: ProfileInfo): Promise<void> {
  const modes = profile.capabilities?.permissionModes ?? []
  const models = profile.models ?? []
  const actions = [
    { label: '$(pencil) Change description', action: 'description' as const },
    ...(models.length > 0
      ? [{ label: '$(symbol-enum) Default model', description: profile.defaults?.model, action: 'model' as const }]
      : []),
    ...(modes.length > 0
      ? [{ label: '$(shield) Default permission mode', description: profile.defaults?.permissionMode, action: 'mode' as const }]
      : []),
    { label: '$(trash) Delete profile', action: 'delete' as const },
  ]
  const picked = await showPick(actions, { title: `${profile.name} — ${host.name}`, placeHolder: unavailable(profile) })
  if (picked === CANCEL || picked === BACK) {
    return
  }
  if (picked.action === 'delete') {
    await confirmDelete(deps, host, client, profile)
    return
  }
  if (picked.action === 'description') {
    const answer = await showInput({
      title: `${profile.name} — description`,
      prompt: 'One line shown beside the name when you create a session.',
      value: profile.description ?? '',
      step: 1,
      totalSteps: 1,
    })
    if (answer === CANCEL || answer === BACK) {
      return
    }
    await apply(
      deps,
      host,
      () => client.updateProfile(profile.name, { description: answer.trim() || undefined }),
      `updated ${profile.name}`,
    )
    return
  }
  if (picked.action === 'model') {
    const choice = await showPick(
      models.map((m) => ({
        label: m.displayName,
        description: m.value === profile.defaults?.model ? 'current' : undefined,
        value: m.value,
      })),
      { title: `${profile.name} — default model` },
    )
    if (choice === CANCEL || choice === BACK) {
      return
    }
    await apply(
      deps,
      host,
      () => client.updateProfile(profile.name, { defaults: { ...profile.defaults, model: choice.value } }),
      `updated ${profile.name}`,
    )
    return
  }
  const choice = await showPick(
    modes.map((mode) => ({ label: mode, description: mode === profile.defaults?.permissionMode ? 'current' : undefined, mode })),
    { title: `${profile.name} — default permission mode` },
  )
  if (choice === CANCEL || choice === BACK) {
    return
  }
  await apply(
    deps,
    host,
    () => client.updateProfile(profile.name, { defaults: { ...profile.defaults, permissionMode: choice.mode } }),
    `updated ${profile.name}`,
  )
}

async function confirmDelete(deps: ProfileFlowDeps, host: GatewayHost, client: WorkerDeckClient, profile: ProfileInfo): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    `Delete profile "${profile.name}" on ${host.name}?`,
    {
      modal: true,
      detail: 'Sessions already running on it are untouched. Nothing in the credential directory it points at is deleted.',
    },
    'Delete',
  )
  if (confirmed === 'Delete') {
    await apply(deps, host, () => client.deleteProfile(profile.name), `deleted ${profile.name}`)
  }
}

// A profile declared in the server's own config is deliberately immutable over the API: the operator's
// config file is the record, and a half-declared profile set is a credential mix-up.
function declared(profile: ProfileInfo, host: GatewayHost): boolean {
  if (profile.managed) {
    return false
  }
  void vscode.window.showInformationMessage(
    `"${profile.name}" is declared in ${host.name}'s own configuration and cannot be changed from here. Edit that gateway's config file.`,
  )
  return true
}

async function create(deps: ProfileFlowDeps, host: GatewayHost, client: WorkerDeckClient): Promise<void> {
  const taken = new Set((await client.listProfiles()).profiles.map((p) => p.name))
  let name = ''
  let engine: EngineChoice = ENGINES[0]!
  let step = 0

  while (step < TOTAL_STEPS) {
    if (step === 0) {
      const answer = await showInput({
        title: `New profile — ${host.name}`,
        prompt: 'What this profile is called when you create a session.',
        placeHolder: 'work',
        value: name,
        step: 1,
        totalSteps: TOTAL_STEPS,
        validate: (value) =>
          value.trim() === '' ? 'name is required' : taken.has(value.trim()) ? `${host.name} already has a profile called that` : undefined,
      })
      if (answer === CANCEL || answer === BACK) {
        return
      }
      name = answer.trim()
      step = 1
    } else if (step === 1) {
      const answer = await showPick(
        ENGINES.map((e) => ({ label: e.label, detail: e.detail, choice: e })),
        {
          title: `New profile — ${host.name}`,
          placeHolder: 'Which engine runs sessions on this profile',
          step: 2,
          totalSteps: TOTAL_STEPS,
        },
      )
      if (answer === CANCEL) {
        return
      }
      if (answer === BACK) {
        step = 0
        continue
      }
      engine = answer.choice
      step = 2
    } else {
      const answer = await showInput({
        title: `New profile — ${host.name}`,
        prompt: engine.dirPrompt,
        placeHolder: engine.dirDefault,
        value: engine.dirDefault,
        step: 3,
        totalSteps: TOTAL_STEPS,
        validate: (value) => (value.trim() === '' ? 'a directory is required' : undefined),
      })
      if (answer === CANCEL) {
        return
      }
      if (answer === BACK) {
        step = 1
        continue
      }
      const dir = resolveRemotePath(answer.trim(), host)
      await apply(
        deps,
        host,
        () =>
          client.createProfile({
            name,
            engine: engine.engine,
            ...(engine.engine === 'codex' ? { codexHome: dir } : { configDir: dir }),
          }),
        `added ${name}`,
      )
      return
    }
  }
}

// `~` is this machine's home, which is the wrong home for every gateway but a loopback one — a remote
// gateway gets the path as typed, and says so itself if the directory is not there.
function resolveRemotePath(input: string, host: GatewayHost): string {
  if (!isLoopbackHost(host)) {
    return input
  }
  if (input === '~') {
    return homedir()
  }
  return input.startsWith('~/') ? join(homedir(), input.slice(2)) : input
}

async function apply(deps: ProfileFlowDeps, host: GatewayHost, work: () => Promise<unknown>, done: string): Promise<void> {
  try {
    const result = await work()
    const profile = result as ProfileInfo | undefined
    const warning = profile && typeof profile === 'object' ? unavailable(profile) : undefined
    void vscode.window.showInformationMessage(`WorkerDeck: ${done} on ${host.name}.${warning ? ` ${warning}` : ''}`)
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: ${describe(err)}`)
    return
  }
  await deps.refresh()
}

// Availability is the gateway's own credential probe, and it is the answer to the only question a new
// profile really raises: does the directory it points at have a login in it?
function unavailable(profile: ProfileInfo): string | undefined {
  return profile.available === false ? `Not usable yet: ${profile.unavailableReason ?? 'no credentials found'}.` : undefined
}

function describeProfile(profile: ProfileInfo): string {
  return [profile.engine ?? 'claude', profile.managed ? undefined : 'declared', profile.available === false ? 'unavailable' : undefined]
    .filter(Boolean)
    .join(' · ')
}

function describe(err: unknown): string {
  const status = (err as { status?: number }).status
  const message = err instanceof Error ? err.message : String(err)
  if (status === 404) {
    return 'this gateway does not allow profile management — start it without `--no-profile-store`'
  }
  if (status === 403) {
    return message
  }
  return message
}

async function pickHost(deps: ProfileFlowDeps): Promise<GatewayHost | undefined> {
  const hosts = deps.hosts()
  if (hosts.length === 0) {
    void vscode.window.showInformationMessage('WorkerDeck: add a gateway first.')
    return undefined
  }
  if (hosts.length === 1) {
    return hosts[0]
  }
  const picked = await showPick(
    hosts.map((host) => ({ label: host.name, description: host.baseUrl, host })),
    { title: 'Profiles', placeHolder: 'Which gateway’s profiles' },
  )
  return picked === CANCEL || picked === BACK ? undefined : picked.host
}
