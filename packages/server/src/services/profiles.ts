/**
 * The profile directory: startup-declared profiles unioned with store-managed
 * ones, validation shared by startup (throws) and the management routes (400s),
 * and the response decoration (`forResponse`) every profile answer goes through.
 *
 * Declared profiles are code — never persisted, never editable over HTTP. The
 * store-managed set is mirrored in memory so every lookup on the request path
 * stays synchronous; `refreshStored()` reloads it after each mutation.
 */
import { existsSync } from 'node:fs'
import { supportsPermissionMode, type ProfileEngine, type ProfileInfo } from '@workerdeck/protocol'
import type { EngineAdapter, EngineAvailability } from '@workerdeck/core'
import { cwdAllowed, engineOf, isProviderProfile } from '../lib/profile-env.ts'
import type { ProfileStore } from './profile-store.ts'

export type Refusal = { status: number; error: string }

export type ProfileServiceOptions = {
  /** Startup-declared profiles (code). */
  declared: ProfileInfo[]
  /** Persistence for dashboard-managed profiles; absent = read-only API. */
  store?: ProfileStore
  /** Roots a managed Claude profile's configDir must resolve inside. */
  allowedConfigDirRoots?: string[]
  disableBypassPermissions?: boolean
  /** True when a `createEngineRunner` factory exists to build provider runners. */
  hasEngineRunnerFactory: boolean
  adapterFor: (engine: ProfileEngine | undefined) => EngineAdapter
  /** Response-time decoration, injected as accessors because the state lives in
   * sibling services (learned default models, availability verdicts, plan usage). */
  decorate: {
    defaultModel: (name: string) => string | undefined
    availability: (name: string) => EngineAvailability | undefined
    usage: (name: string) => ProfileInfo['usage'] | undefined
  }
}

export class ProfileService {
  readonly #declared: ProfileInfo[]
  readonly #declaredByName: Map<string, ProfileInfo>
  /** Store-managed profiles, mirrored in memory — see the module doc. */
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

  /**
   * Everything wrong with a profile that the server can tell without running it.
   * Shared by startup (where it throws) and the management routes (where it 400s),
   * so a profile created over HTTP can never be one startup would have refused.
   */
  validate(p: ProfileInfo): string | null {
    const { adapterFor, disableBypassPermissions, hasEngineRunnerFactory } = this.#opts
    if (isProviderProfile(p)) {
      // Provider profiles have no config dir; they need an engine factory to
      // build a runner at all, so refuse up front rather than at create time.
      if (!p.provider?.id) {
        return `provider profile '${p.name}' is missing provider.id`
      }
      if (!hasEngineRunnerFactory) {
        return `profile '${p.name}' uses engine 'provider' but no ` + '`createEngineRunner` was provided to build one'
      }
    } else if (p.engine === 'codex') {
      // The codexHome pin mirrors the claude configDir rule: a declared dir
      // must exist. Unset is fine — the binary's own ~/.codex.
      if (p.codexHome && !existsSync(p.codexHome)) {
        return `profile '${p.name}' codexHome does not exist: ${p.codexHome}`
      }
      // No instructions surface exists (codex reads AGENTS.md from the cwd);
      // refusing beats silently dropping what the operator wrote.
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
    // A default the profile's own engine can't run is misconfiguration: catch it
    // here rather than on every create under that profile.
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

  /** Reload the in-memory mirror of the store — once at `listen()`, and after
   * each management-route mutation. Single-process, like the bundled queue. */
  async refreshStored(): Promise<void> {
    if (!this.#opts.store) {
      return
    }
    this.#stored.clear()
    for (const p of await this.#opts.store.list()) {
      this.#stored.set(p.name, p)
    }
  }

  /** Response-only marker so a UI knows which rows it may edit. Declared profiles
   * are code; only store-backed ones can be changed over the API. */
  withManagedFlag(p: ProfileInfo): ProfileInfo {
    return this.#declaredByName.has(p.name) ? p : { ...p, managed: true }
  }

  /**
   * Response shape for a profile: the managed marker, the engine's capability
   * record, its static model catalog (correct from the first request — no
   * warm-up session, no process spawned), the availability verdict when one
   * has been probed, the learned default model (the one thing a static
   * catalog cannot know: a claude profile's default is the operator's CLI
   * config, so it stays absent until a session on the profile reports it),
   * and the plan usage learned from the profile's sessions' rate_limit events.
   * Read-only decoration — never persisted.
   */
  forResponse(p: ProfileInfo): ProfileInfo {
    const { adapterFor, decorate } = this.#opts
    const adapter = adapterFor(p.engine)
    const base: ProfileInfo = {
      ...this.withManagedFlag(p),
      capabilities: adapter.capabilities,
    }
    // Provider model ids are operator-declared (provider.models); an empty
    // catalog must not shadow them with an empty picker.
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
    // Plan usage, learned like the default model and display-only like the
    // availability verdict. The 0%-after-elapsed-reset inference happens in
    // `usage()` per request, so it is computed against *this* moment's clock.
    const usage = decorate.usage(p.name)
    if (usage) {
      base.usage = usage
    }
    return base
  }

  /** Declared profiles first: a name collision means the code wins, and the stored
   * one is unreachable rather than silently overriding server options. */
  all(): ProfileInfo[] {
    return [...this.#declared, ...[...this.#stored.values()].filter((p) => !this.#declaredByName.has(p.name))]
  }

  get(name: string): ProfileInfo | undefined {
    return this.#declaredByName.get(name) ?? this.#stored.get(name)
  }

  /** Profile management is doubly opt-in: the operator wires a store, and the host
   * marks the principal. Neither on its own is enough. */
  manageGuard(auth: { canManageProfiles?: boolean }): Refusal | null {
    if (!this.#opts.store) {
      return { status: 404, error: 'profile management is not enabled on this server' }
    }
    if (!auth.canManageProfiles) {
      return { status: 403, error: 'not allowed to manage profiles' }
    }
    return null
  }

  /** Startup-declared profiles are code. Editing one over HTTP would make the
   * server options lie about what is actually running. */
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

  /**
   * A managed Claude profile names a config directory, and that directory is a
   * credential store. Bound it to operator-declared roots; unset roots means the
   * management routes create provider profiles only.
   */
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

  /** Validate and persist a managed profile. Shared by create and update so a
   * PATCH can never leave behind a profile a POST would have refused. Returns
   * the saved profile (managed-flagged) or a refusal. */
  async saveManaged(incoming: ProfileInfo): Promise<{ ok: true; profile: ProfileInfo } | ({ ok: false } & Refusal)> {
    // `managed` is server-computed on every response; never persist a client's copy.
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
