import { existsSync } from 'node:fs'
import { supportsPermissionMode, type ProfileEngine, type ProfileInfo } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '@workerdeck/core'
import { cwdAllowed, engineOf, isProviderProfile } from '../lib/profile-env.ts'
import type { ProfileStore } from './profile-store.ts'

export type Refusal = { status: number; error: string }

export type ProfileServiceOptions = {
  declared: ProfileInfo[]
  store?: ProfileStore
  allowedConfigDirRoots?: string[]
  disableBypassPermissions?: boolean
  hasEngineRunnerFactory: boolean
  adapterFor: (engine: ProfileEngine | undefined) => EngineAdapter
  decorate: {
    defaultModel: (name: string) => string | undefined
    availability: (name: string) => EngineAvailability | undefined
    usage: (name: string) => ProfileInfo['usage'] | undefined
  }
}

export class ProfileService {
  readonly #declared: ProfileInfo[]
  readonly #declaredByName: Map<string, ProfileInfo>
  readonly #stored = new Map<string, ProfileInfo>()
  readonly #opts: ProfileServiceOptions

  constructor(opts: ProfileServiceOptions) {
    this.#opts = opts
    this.#declared = opts.declared
    this.#declaredByName = new Map(opts.declared.map((p) => [p.name, p]))
    if (this.#declaredByName.size !== opts.declared.length) {
      throw new Error('createWorkerServer: duplicate profile names in `profiles`')
    }
  }

  validate(p: ProfileInfo): string | null {
    const { adapterFor, disableBypassPermissions, hasEngineRunnerFactory } = this.#opts
    if (isProviderProfile(p)) {
      if (!p.provider?.id) {
        return `provider profile '${p.name}' is missing provider.id`
      }
      if (!hasEngineRunnerFactory) {
        return `profile '${p.name}' uses engine 'provider' but no ` + '`createEngineRunner` was provided to build one'
      }
    } else if (p.engine === 'codex') {
      if (p.codexHome && !existsSync(p.codexHome)) {
        return `profile '${p.name}' codexHome does not exist: ${p.codexHome}`
      }
      if (p.session?.instructions) {
        return (
          `profile '${p.name}' declares session.instructions, which the codex engine cannot ` +
          'deliver — put instructions in the target repo’s AGENTS.md instead'
        )
      }
    } else if (!p.configDir || !existsSync(p.configDir)) {
      return `profile '${p.name}' configDir does not exist: ${p.configDir}`
    }
    if (disableBypassPermissions && p.defaults?.permissionMode === 'bypassPermissions') {
      return `profile '${p.name}' defaults to bypassPermissions but disableBypassPermissions is set`
    }
    const fallbackMode = p.defaults?.permissionMode
    if (fallbackMode && !supportsPermissionMode(p.engine, fallbackMode)) {
      return (
        `profile '${p.name}' defaults to permission mode '${fallbackMode}', which engine ` +
        `'${engineOf(p)}' does not support (supported: ` +
        `${adapterFor(engineOf(p)).capabilities.permissionModes.join(', ')})`
      )
    }
    return null
  }

  async refreshStored(): Promise<void> {
    if (!this.#opts.store) {
      return
    }
    this.#stored.clear()
    for (const p of await this.#opts.store.list()) {
      this.#stored.set(p.name, p)
    }
  }

  withManagedFlag(p: ProfileInfo): ProfileInfo {
    return this.#declaredByName.has(p.name) ? p : { ...p, managed: true }
  }

  forResponse(p: ProfileInfo): ProfileInfo {
    const { adapterFor, decorate } = this.#opts
    const adapter = adapterFor(p.engine)
    const base: ProfileInfo = {
      ...this.withManagedFlag(p),
      capabilities: adapter.capabilities,
    }
    if (adapter.catalog.models.length > 0) {
      base.models = adapter.catalog.models
    }
    const defaultModel = decorate.defaultModel(p.name)
    if (defaultModel) {
      base.defaultModel = defaultModel
    }
    const probed = decorate.availability(p.name)
    if (probed && probed.available !== 'unknown') {
      base.available = probed.available
      if (probed.available === false) {
        base.unavailableReason = probed.reason
      }
    }
    const usage = decorate.usage(p.name)
    if (usage) {
      base.usage = usage
    }
    return base
  }

  all(): ProfileInfo[] {
    return [...this.#declared, ...[...this.#stored.values()].filter((p) => !this.#declaredByName.has(p.name))]
  }

  get(name: string): ProfileInfo | undefined {
    return this.#declaredByName.get(name) ?? this.#stored.get(name)
  }

  manageGuard(auth: { canManageProfiles?: boolean }): Refusal | null {
    if (!this.#opts.store) {
      return { status: 404, error: 'profile management is not enabled on this server' }
    }
    if (!auth.canManageProfiles) {
      return { status: 403, error: 'not allowed to manage profiles' }
    }
    return null
  }

  declaredGuard(profile: ProfileInfo): Refusal | null {
    return this.#declaredByName.has(profile.name)
      ? {
          status: 403,
          error:
            `profile '${profile.name}' is declared in server options and cannot be changed ` +
            'over the API — edit the `profiles` option instead',
        }
      : null
  }

  configDirGuard(profile: ProfileInfo): Refusal | null {
    if (isProviderProfile(profile)) {
      return null
    }
    const roots = this.#opts.allowedConfigDirRoots
    if (!roots || roots.length === 0) {
      return {
        status: 403,
        error: 'managed Claude profiles are disabled: set `allowedConfigDirRoots` to the ' + 'directories they may point at',
      }
    }
    return profile.configDir && cwdAllowed(profile.configDir, roots)
      ? null
      : { status: 403, error: 'configDir is outside the allowed roots' }
  }

  async saveManaged(incoming: ProfileInfo): Promise<{ ok: true; profile: ProfileInfo } | ({ ok: false } & Refusal)> {
    const { managed: _clientClaim, ...profile } = incoming
    const refused = this.configDirGuard(profile)
    if (refused) {
      return { ok: false, ...refused }
    }
    const invalid = this.validate(profile)
    if (invalid) {
      return { ok: false, status: 400, error: invalid }
    }
    await this.#opts.store!.save(profile)
    await this.refreshStored()
    return { ok: true, profile: this.withManagedFlag(profile) }
  }
}
