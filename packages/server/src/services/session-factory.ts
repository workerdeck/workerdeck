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
  refs: {
    registry?: SessionRegistry
    parking?: SessionParkManager
    bridge?: BridgeHub
  }
}

export type SessionFactory = ReturnType<typeof createSessionFactory>

export function createSessionFactory(deps: SessionFactoryDeps) {
  const { adapterFor, profiles, refs } = deps

  const subscriptionNoticeShown = new Set<string>()

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

  const stripInertFields = (req: CreateSessionRequest, profile: ProfileInfo | undefined): void => {
    if (!adapterFor(profile?.engine).capabilities.interactiveApprovals) {
      delete req.questionBehavior
    }
  }

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
    const tooBig = checkScope(merged)
    if (tooBig) {
      return { status: 400, error: tooBig }
    }
    req.scope = merged
    return null
  }

  const checkCwd = (req: CreateSessionRequest, profile: ProfileInfo | undefined): { status: number; error: string } | null => {
    if (req.cwd !== undefined && typeof req.cwd !== 'string') {
      return { status: 400, error: 'cwd must be a string' }
    }
    if (!req.cwd) {
      // Absent = true, so an engine record predating the field keeps the old always-required behaviour.
      return adapterFor(profile?.engine).capabilities.hostCwd === false ? null : { status: 400, error: 'cwd is required' }
    }
    return cwdAllowed(req.cwd, deps.allowedCwdRoots) ? null : { status: 403, error: 'cwd is outside the allowed roots' }
  }

  const withScope = (config: SessionRunnerConfig, scope: Record<string, string> | undefined): SessionRunnerConfig =>
    scope === undefined ? config : { ...config, scope }

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
    if (engineOf(profile) !== 'claude') {
      return config
    }
    const base = config.env ?? process.env
    const env = claudeSessionEnv(profile, base)
    // A skipped pin returns `base` itself — leaving the config alone keeps an unset `env` unset, so the SDK spawns on process.env.
    return env === base ? config : { ...config, env }
  }

  const sessionEnvFor = (profile: ProfileInfo): Record<string, string | undefined> => {
    try {
      return buildRunnerConfig({ cwd: process.cwd(), profile: profile.name }).env ?? process.env
    } catch {
      return engineOf(profile) === 'claude' ? claudeSessionEnv(profile, process.env) : process.env
    }
  }

  const buildRunner = async (config: SessionRunnerConfig, restore?: RunnerSnapshot, id?: string): Promise<Runner> => {
    const name = config.profile
    const profile = name !== undefined ? profiles.get(name) : undefined
    if (name !== undefined && !profile) {
      throw new Error(`unknown profile: ${name}`)
    }
    const runner =
      profile && isProviderProfile(profile)
        ? // Non-null: startup refuses a provider profile when no factory was wired.
          await deps.createEngineRunner!({ config, profile, bridge: refs.bridge!, restore, id })
        : // The in-repo adapters refuse `restore` themselves — neither binary can rebuild a parked session.
          await adapterFor(profile?.engine).createRunner({ config, profile, restore, id })
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
    // Watchers first, then start: a session must not emit anything before the things that persist and account for it are listening.
    refs.parking!.remember(runner.id, config)
    refs.parking!.watch(runner)
    void runner.start()
    return runner
  }

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
