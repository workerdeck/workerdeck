/**
 * The create pipeline: everything between a `CreateSessionRequest` arriving and
 * a `Runner` running — policy checks (bypass, permission mode, engine grants,
 * scope, cwd), profile resolution, config assembly (`buildRunnerConfig`), and
 * the one chokepoint that builds runners for create, dormant rebuild and parked
 * rebuild alike (`buildRunner`).
 *
 * Registry/parking/bridge are handed in as late-bound refs because construction
 * is mutually recursive with them (parking's rebuild callback calls
 * `buildRunner`; `createRunner` registers and watches). The refs are filled
 * during assembly, before the server accepts a request.
 */
import {
  supportsPermissionMode,
  type CreateSessionRequest,
  type PermissionMode,
  type ProfileEngine,
  type ProfileInfo,
} from '@workerdeck/protocol'
import type { EngineAdapter, Runner, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import { checkScope, sameScope } from '../lib/scope.ts'
import { claudeSessionEnv, cwdAllowed, engineOf, isProviderProfile } from '../lib/profile-env.ts'
import type { EngineRunnerContext } from '../options.ts'
import type { BridgeHub } from './bridge.ts'
import type { SessionParkManager } from './parking.ts'
import type { ProfileService } from './profiles.ts'
import type { SessionRegistry } from './registry.ts'

export type SessionFactoryDeps = {
  adapterFor: (engine: ProfileEngine | undefined) => EngineAdapter
  profiles: ProfileService
  hostBuildRunnerConfig: (req: CreateSessionRequest) => SessionRunnerConfig
  createEngineRunner?: (context: EngineRunnerContext) => Runner | Promise<Runner>
  allowedCwdRoots?: string[]
  disableBypassPermissions?: boolean
  requireApiKey?: boolean
  /** Late-bound: filled during assembly, read at call time. */
  refs: {
    registry?: SessionRegistry
    parking?: SessionParkManager
    bridge?: BridgeHub
  }
}

export type SessionFactory = ReturnType<typeof createSessionFactory>

export function createSessionFactory(deps: SessionFactoryDeps) {
  const { adapterFor, profiles, refs } = deps

  /** Profiles (by name; '' = none) whose oauth notice has been logged. */
  const subscriptionNoticeShown = new Set<string>()

  /** Enforce the server's bypass policy on a create request. Returns a 403 message
   * for an explicit bypass-mode request; strips the pre-authorization capability
   * silently (see the option's doc for why). */
  const applyBypassPolicy = (req: CreateSessionRequest): string | null => {
    if (!deps.disableBypassPermissions) {
      return null
    }
    if (req.permissionMode === 'bypassPermissions') {
      return 'bypassPermissions is disabled on this server (disableBypassPermissions)'
    }
    delete req.allowDangerouslySkipPermissions
    return null
  }

  /** Reject a permission mode the resolved profile's engine has no meaning for.
   * The create form already filters what it offers, but the API is the boundary:
   * a provider session asked for 'plan' should be told so, not silently coerced
   * into 'default' by whatever assembles its runner. Returns an error message. */
  const checkPermissionMode = (mode: PermissionMode | undefined, profile: ProfileInfo | undefined): string | null => {
    if (mode === undefined || supportsPermissionMode(profile?.engine, mode)) {
      return null
    }
    return (
      `permission mode '${mode}' is not supported by profile '${profile!.name}' ` +
      `(engine '${engineOf(profile)}') — supported: ` +
      adapterFor(profile?.engine).capabilities.permissionModes.join(', ')
    )
  }

  /**
   * Refuse the request fields the resolved profile's engine cannot honor —
   * read off its capability record, so the create form's filtering and the
   * API boundary can never disagree. Refusing beats coercing: a caller who
   * asked for something the engine has no meaning for should be told, not
   * left wondering where the option went. Also enforces the provider grant
   * rules (capabilities narrow, never widen; MCP servers are the profile's to
   * declare — MCP tools are authoritative, server-side, with server
   * credentials, so honoring a client-supplied server would let a caller
   * point an authoritative tool anywhere it liked).
   */
  const checkEngineGrants = (req: CreateSessionRequest, profile: ProfileInfo | undefined): string | null => {
    const engine = engineOf(profile)
    const caps = adapterFor(profile?.engine).capabilities
    const name = profile?.name ?? 'default'
    if (!caps.sessionMcpServers && req.mcpServers && Object.keys(req.mcpServers).length > 0) {
      return (
        `profile '${name}' runs the ${engine} engine, whose MCP servers are declared ` +
        'outside the session request — a request cannot add its own'
      )
    }
    if (!caps.budgets && (req.maxTurns !== undefined || req.maxBudgetUsd !== undefined)) {
      return `the ${engine} engine does not honor maxTurns/maxBudgetUsd`
    }
    if (!caps.settingSources && req.settingSources !== undefined) {
      return `the ${engine} engine does not load settingSources`
    }
    if (!caps.resume && req.resume !== undefined) {
      return `the ${engine} engine cannot resume a session`
    }
    if (req.forkSession && engine !== 'claude') {
      return `the ${engine} engine cannot fork a resumed session`
    }
    if (req.reasoningEffort !== undefined && (!caps.reasoningEfforts || caps.reasoningEfforts.length === 0)) {
      return `the ${engine} engine does not take a reasoningEffort`
    }
    if (!profile || !isProviderProfile(profile)) {
      return null
    }
    const granted = profile.session?.capabilities
    if (!req.capabilities || !granted) {
      return null
    }
    const ungranted = req.capabilities.filter((c) => !granted.includes(c))
    if (ungranted.length === 0) {
      return null
    }
    return (
      `profile '${profile.name}' does not grant: ${ungranted.join(', ')} ` +
      `(granted: ${granted.join(', ') || 'none'}) — a request may narrow capabilities, not widen them`
    )
  }

  /** Drop request fields that are meaningless (not wrong) for the engine —
   * today just `questionBehavior` where no approval channel exists, so job
   * webhooks never grow phantom permission_requested expectations. */
  const stripInertFields = (req: CreateSessionRequest, profile: ProfileInfo | undefined): void => {
    if (!adapterFor(profile?.engine).capabilities.interactiveApprovals) {
      delete req.questionBehavior
    }
  }

  /**
   * Validate the request's scope and merge the principal's into it.
   *
   * A scoped principal's keys are *filled in* when the request omits them and
   * *refused* when the request disagrees: a caller inside a scope may narrow
   * itself with extra tags, never claim to be somewhere else. That makes an
   * embedder's stamping proxy defense in depth rather than the only line — a
   * request that slipped past it still cannot create a session in another
   * scope. An unscoped principal (the operator) may write any tags.
   */
  const applyScope = (req: CreateSessionRequest, auth: { scope?: Record<string, string> }): { status: number; error: string } | null => {
    const invalid = checkScope(req.scope)
    if (invalid) {
      return { status: 400, error: invalid }
    }
    if (!auth.scope) {
      return null
    }
    const merged: Record<string, string> = { ...req.scope }
    for (const [key, value] of Object.entries(auth.scope)) {
      const claimed = merged[key]
      if (claimed !== undefined && claimed !== value) {
        return { status: 403, error: `scope '${key}' does not match the caller's` }
      }
      merged[key] = value
    }
    // Re-checked after the merge, so the advertised bound is the real ceiling
    // rather than one the principal's own keys can push past.
    const tooBig = checkScope(merged)
    if (tooBig) {
      return { status: 400, error: tooBig }
    }
    req.scope = merged
    return null
  }

  /**
   * `cwd`, required or not depending on the engine's capability record — the
   * record rather than the engine name, so a host engine that has no host
   * filesystem gets the same treatment without this file learning its name.
   *
   * When one *is* supplied it is validated even for an engine that will not read
   * it: a path the caller went out of their way to name should not be quietly
   * exempt from the operator's roots. And note what this check is not — for a
   * filesystem-less engine `allowedCwdRoots` guards nothing at all. The
   * boundary there is the capability wiring, not a path prefix.
   */
  const checkCwd = (req: CreateSessionRequest, profile: ProfileInfo | undefined): { status: number; error: string } | null => {
    if (req.cwd !== undefined && typeof req.cwd !== 'string') {
      return { status: 400, error: 'cwd must be a string' }
    }
    if (!req.cwd) {
      // Absent = true, so an engine record that predates the field keeps the old
      // always-required behaviour.
      return adapterFor(profile?.engine).capabilities.hostCwd === false ? null : { status: 400, error: 'cwd is required' }
    }
    return cwdAllowed(req.cwd, deps.allowedCwdRoots) ? null : { status: 403, error: 'cwd is outside the allowed roots' }
  }

  /**
   * Re-stamp the request's scope onto whatever the host's `buildRunnerConfig`
   * returned. The hook is host code and may rewrite the config wholesale; a
   * hook that dropped `scope` would silently *widen* a session's visibility,
   * which is the one direction a bug here must not go. Same posture as the
   * profile's env pin winning over the hook.
   */
  const withScope = (config: SessionRunnerConfig, scope: Record<string, string> | undefined): SessionRunnerConfig =>
    scope === undefined ? config : { ...config, scope }

  /** Profile-aware config hook: fill the profile's defaults into unset request fields,
   * run the host hook, then pin CLAUDE_CONFIG_DIR — the profile wins even when the
   * host hook set its own env (see `claudeSessionEnv` for the one case the pin is
   * skipped, and why). Handed to the queue too, so jobs inherit profiles. */
  const buildRunnerConfig = (req: CreateSessionRequest): SessionRunnerConfig => {
    const profile = req.profile !== undefined ? profiles.get(req.profile) : undefined
    if (!profile) {
      return withScope(deps.hostBuildRunnerConfig(req), req.scope)
    }
    const config = withScope(
      deps.hostBuildRunnerConfig({
        ...req,
        model: req.model ?? profile.defaults?.model ?? profile.provider?.model,
        permissionMode: req.permissionMode ?? profile.defaults?.permissionMode,
      }),
      req.scope,
    )
    // Only claude profiles have a config dir to pin. Provider credentials come
    // from the operator's environment through the engine factory; a codex
    // profile's CODEX_HOME pin is applied by its adapter (the runner builds the
    // child env, because CodexOptions.env replaces rather than merges).
    if (engineOf(profile) !== 'claude') {
      return config
    }
    const base = config.env ?? process.env
    const env = claudeSessionEnv(profile, base)
    // A skipped pin returns `base` itself — leave the config alone so an unset
    // `env` stays unset (the SDK then spawns on process.env, unmaterialized).
    return env === base ? config : { ...config, env }
  }

  /** The env a probe should test: exactly what the real assembly path produces. */
  const sessionEnvFor = (profile: ProfileInfo): Record<string, string | undefined> => {
    try {
      return buildRunnerConfig({ cwd: process.cwd(), profile: profile.name }).env ?? process.env
    } catch {
      // A host hook may choke on a probe-shaped request; fall back to the
      // profile pin alone, applied exactly as the real path applies it.
      return engineOf(profile) === 'claude' ? claudeSessionEnv(profile, process.env) : process.env
    }
  }

  /** Build a runner for a session, choosing the engine from its profile. Async
   * because the engine factory may be: a provider session can need an awaited
   * assembly step (per-session MCP connect) before it has a runner at all.
   *
   * `restore` rebuilds a parked session rather than creating a new one — same id,
   * same log, mid-task. */
  const buildRunner = async (
    config: SessionRunnerConfig,
    restore?: RunnerSnapshot,
    /** Adopt this id rather than minting one — rehydrating a dormant session. */
    id?: string,
  ): Promise<Runner> => {
    const name = config.profile
    const profile = name !== undefined ? profiles.get(name) : undefined
    if (name !== undefined && !profile) {
      // Only reachable on a resume: profiles can be deleted between park and
      // wake-up, and the session cannot be rebuilt without the one it ran on.
      throw new Error(`unknown profile: ${name}`)
    }
    const runner =
      profile && isProviderProfile(profile)
        ? // Guaranteed present: startup refuses provider profiles without a factory.
          await deps.createEngineRunner!({ config, profile, bridge: refs.bridge!, restore, id })
        : // claude and codex ship as in-repo adapters; each refuses `restore` itself
          // (neither engine can rebuild a parked session — the binary owns its state).
          await adapterFor(profile?.engine).createRunner({ config, profile, restore, id })
    // The single chokepoint for create, dormant rebuild and parked rebuild, so
    // it is the one place worth checking that the runner reports the scope it
    // was built with. A host-supplied runner that forgot to echo it would be
    // invisible to every enforcement point below and visible to everyone.
    const reported = runner.info().scope
    if (!sameScope(reported, config.scope)) {
      throw new Error(
        `runner for session ${runner.id} reports scope ${JSON.stringify(reported)}, ` +
          `expected ${JSON.stringify(config.scope)} — echo config.scope from info()`,
      )
    }
    return runner
  }

  const createRunner = async (config: SessionRunnerConfig): Promise<Runner> => {
    const runner = refs.registry!.register(await buildRunner(config))
    // Watchers first, then start: a session must not emit anything before the
    // things that persist and account for it are listening.
    refs.parking!.remember(runner.id, config)
    refs.parking!.watch(runner)
    void runner.start()
    return runner
  }

  /** Resolve a request's profile: required when several are declared, implicit with
   * exactly one, scoped by the principal's allowedProfiles. Returns the resolved
   * profile (undefined when the server declares none) or a response-ready error. */
  const resolveProfile = (
    name: unknown,
    allowedProfiles: string[] | undefined,
  ): { ok: true; profile?: ProfileInfo } | { ok: false; status: number; error: string } => {
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, status: 400, error: 'profile must be a string' }
    }
    const all = profiles.all()
    if (all.length === 0) {
      return name !== undefined ? { ok: false, status: 400, error: 'no profiles are configured on this server' } : { ok: true }
    }
    const effective = name ?? (all.length === 1 ? all[0]!.name : undefined)
    if (effective === undefined) {
      const available = all.map((p) => p.name).join(', ')
      return { ok: false, status: 400, error: `profile is required (available: ${available})` }
    }
    const profile = profiles.get(effective)
    if (!profile) {
      return { ok: false, status: 400, error: `unknown profile: ${effective}` }
    }
    if (allowedProfiles && !allowedProfiles.includes(profile.name)) {
      return { ok: false, status: 403, error: `profile not allowed: ${profile.name}` }
    }
    return { ok: true, profile }
  }

  // Watch each session's init handshake for its auth provenance ('oauth' = claude.ai
  // subscription). The listener is a no-op after the first init; not worth unsubscribing.
  const watchAuthSource = (runner: Runner): void => {
    let seen = false
    runner.subscribe((event) => {
      if (seen || event.type !== 'system_init') {
        return
      }
      seen = true
      if (event.apiKeySource !== 'oauth') {
        return
      }
      if (deps.requireApiKey) {
        runner.fail(
          'This server requires API-key auth (requireApiKey), but the session initialized ' +
            "with claude.ai subscription credentials (apiKeySource 'oauth'). Set " +
            'ANTHROPIC_API_KEY (or Bedrock/Vertex auth) in the server environment.',
        )
      } else {
        // Per profile, not global: distinct profiles are distinct accounts, and each
        // operator deserves the notice once.
        const profileName = runner.info().profile ?? ''
        if (subscriptionNoticeShown.has(profileName)) {
          return
        }
        subscriptionNoticeShown.add(profileName)
        const scope = profileName ? `Sessions under profile '${profileName}'` : 'Sessions'
        console.warn(
          `[workerdeck] ${scope} are using claude.ai subscription credentials ` +
            "(apiKeySource 'oauth'), not an API key. That is only appropriate for personal, " +
            'single-user use of your own account. Unattended/scheduled or multi-user use ' +
            "requires an API key under Anthropic's terms — set ANTHROPIC_API_KEY in the " +
            'server environment, or set requireApiKey: true to fail closed.',
        )
      }
    })
  }

  return {
    applyBypassPolicy,
    checkPermissionMode,
    checkEngineGrants,
    stripInertFields,
    applyScope,
    checkCwd,
    buildRunnerConfig,
    sessionEnvFor,
    buildRunner,
    createRunner,
    resolveProfile,
    watchAuthSource,
  }
}
