import {
  supportsPermissionMode,
  type CreateSessionRequest,
  type EngineCapabilities,
  type PermissionMode,
  type PricingTable,
  type ProfileEngine,
  type ProfileInfo,
} from '@workerdeck/protocol'
import { composeInstructions } from '@workerdeck/core'
import type {
  AvatarDirectory,
  ContextResetDirectory,
  EngineAdapter,
  PeerDirectory,
  Runner,
  RunnerSnapshot,
  SessionRunnerConfig,
  ShellDirectory,
} from '@workerdeck/core'
import type { Refusal } from '../lib/http.ts'
import { refusePermissionMode } from '../lib/permissions.ts'
import { checkScope, sameScope } from '../lib/scope.ts'
import { cwdAllowed, engineOf, isProviderProfile } from '../lib/profile-env.ts'
import type { EngineRunnerContext, ShellAgentWriteOption } from '../options.ts'
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
  approvalTimeoutMs?: number | null
  effortDefaults?: Record<string, string>
  requireApiKey?: boolean
  peers?: PeerDirectory
  contextReset?: { directory: ContextResetDirectory; defaultEnabled: boolean }
  shells?: ShellDirectory
  shellAgentWrite?: ShellAgentWriteOption
  pricing?: PricingTable
  registry: SessionRegistry
  parking: SessionParkManager
  bridge: BridgeHub
  agentBrief?: (sessionId: string | undefined) => string | undefined
  avatar?: { directory: AvatarDirectory; isAgent: (sessionId: string | undefined) => boolean }
}

// `agent` marks a create the agent is bound to only after the runner exists, as `brief` does for its brief.
export type BuildOptions = { brief?: string; agent?: boolean }

// A dormant rebuild spreads the stored config back in, so the principal's flag can arrive on the request; a create
// door passes it beside the request instead, because the host's hook and a job record see only the wire type.
export type CreateRequestWithPrincipal = CreateSessionRequest & { createdByOperator?: boolean }

export type SessionPrincipal = { operator: boolean }

export type SessionFactory = ReturnType<typeof createSessionFactory>

type EngineGrant = {
  refuses: (req: CreateSessionRequest, caps: EngineCapabilities) => boolean
  error: (engine: string, name: string) => string
}

const ENGINE_GRANTS: readonly EngineGrant[] = [
  {
    refuses: (req, caps) => !caps.sessionMcpServers && !!req.mcpServers && Object.keys(req.mcpServers).length > 0,
    error: (engine, name) =>
      `profile '${name}' runs the ${engine} engine, whose MCP servers are declared outside the session request - a request cannot add its own`,
  },
  {
    refuses: (req, caps) => !caps.budgets && (req.maxTurns !== undefined || req.maxBudgetUsd !== undefined),
    error: (engine) => `the ${engine} engine does not honor maxTurns/maxBudgetUsd`,
  },
  {
    refuses: (req, caps) => !caps.settingSources && req.settingSources !== undefined,
    error: (engine) => `the ${engine} engine does not load settingSources`,
  },
  { refuses: (req, caps) => !caps.resume && req.resume !== undefined, error: (engine) => `the ${engine} engine cannot resume a session` },
  {
    refuses: (req, caps) => !!req.forkSession && caps.forkSession !== true,
    error: (engine) => `the ${engine} engine cannot fork a resumed session`,
  },
  {
    refuses: (req, caps) => req.reasoningEffort !== undefined && (!caps.reasoningEfforts || caps.reasoningEfforts.length === 0),
    error: (engine) => `the ${engine} engine does not take a reasoningEffort`,
  },
]

// Applied after the host's hook for the same reason as scope: the hook may rebuild the config from the request.
function withPrincipal(config: SessionRunnerConfig, operator: boolean | undefined): SessionRunnerConfig {
  return operator === undefined ? config : { ...config, createdByOperator: operator }
}

export function createSessionFactory(deps: SessionFactoryDeps) {
  const { adapterFor, profiles, registry, parking, bridge } = deps

  const subscriptionNoticeShown = new Set<string>()

  const applyBypassPolicy = (req: CreateSessionRequest): string | null => {
    if (!deps.disableBypassPermissions) {
      return null
    }
    const refused = refusePermissionMode(req.permissionMode, { operator: true, disableBypass: true })
    if (refused) {
      return refused
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
      `(engine '${engineOf(profile)}') - supported: ` +
      adapterFor(profile?.engine).capabilities.permissionModes.join(', ')
    )
  }

  const checkEngineGrants = (req: CreateSessionRequest, profile: ProfileInfo | undefined): string | null => {
    const caps = adapterFor(profile?.engine).capabilities
    const grant = ENGINE_GRANTS.find((candidate) => candidate.refuses(req, caps))
    if (grant) {
      return grant.error(engineOf(profile), profile?.name ?? 'default')
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
      `(granted: ${granted.join(', ') || 'none'}) - a request may narrow capabilities, not widen them`
    )
  }

  const stripInertFields = (req: CreateSessionRequest, profile: ProfileInfo | undefined): void => {
    if (!adapterFor(profile?.engine).capabilities.interactiveApprovals) {
      delete req.questionBehavior
    }
  }

  const applyScope = (req: CreateSessionRequest, auth: { scope?: Record<string, string> }): Refusal | null => {
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

  const checkCwd = (req: CreateSessionRequest, profile: ProfileInfo | undefined): Refusal | null => {
    if (req.cwd !== undefined && typeof req.cwd !== 'string') {
      return { status: 400, error: 'cwd must be a string' }
    }
    if (!req.cwd) {
      // Absent = true: an engine record that omits the field keeps the always-required behaviour.
      return adapterFor(profile?.engine).capabilities.hostCwd === false ? null : { status: 400, error: 'cwd is required' }
    }
    return cwdAllowed(req.cwd, deps.allowedCwdRoots) ? null : { status: 403, error: 'cwd is outside the allowed roots' }
  }

  const withScope = (config: SessionRunnerConfig, scope: Record<string, string> | undefined): SessionRunnerConfig =>
    scope === undefined ? config : { ...config, scope }

  // The gateway's default reaches every engine through the config, so a runner rebuilt from a parked
  // record gets the same deadline policy as the one it replaces.
  const withApprovalDefault = (config: SessionRunnerConfig): SessionRunnerConfig =>
    deps.approvalTimeoutMs === undefined ? config : { ...config, defaultApprovalTimeoutMs: deps.approvalTimeoutMs }

  const buildRunnerConfig = (req: CreateRequestWithPrincipal, principal?: SessionPrincipal): SessionRunnerConfig => {
    const profile = req.profile !== undefined ? profiles.get(req.profile) : undefined
    const effective = profile
      ? {
          ...req,
          model: req.model ?? profile.defaults?.model ?? profile.provider?.model,
          permissionMode: req.permissionMode ?? profile.defaults?.permissionMode,
        }
      : req
    const config = withApprovalDefault(
      withPrincipal(withScope(deps.hostBuildRunnerConfig(effective), req.scope), principal?.operator ?? req.createdByOperator),
    )
    const sessionEnv = profile ? adapterFor(profile.engine).sessionEnv : undefined
    if (!profile || !sessionEnv) {
      return config
    }
    const base = config.env ?? process.env
    const env = sessionEnv(profile, base)
    // A skipped pin returns `base` itself - leaving the config alone keeps an unset `env` unset, so the SDK spawns on process.env.
    return env === base ? config : { ...config, env }
  }

  const sessionEnvFor = (profile: ProfileInfo): Record<string, string | undefined> => {
    try {
      return buildRunnerConfig({ cwd: process.cwd(), profile: profile.name }).env ?? process.env
    } catch {
      return adapterFor(profile.engine).sessionEnv?.(profile, process.env) ?? process.env
    }
  }

  const buildRunner = async (
    built: SessionRunnerConfig,
    restore?: RunnerSnapshot,
    id?: string,
    options?: BuildOptions,
  ): Promise<Runner> => {
    const name = built.profile
    const profile = name !== undefined ? profiles.get(name) : undefined
    if (name !== undefined && !profile) {
      throw new Error(`unknown profile: ${name}`)
    }
    const capabilities = profile?.capabilities ?? adapterFor(profile?.engine).capabilities
    // Applied here rather than in buildRunnerConfig so a parked record, which stores its config, gets it too. The shell
    // tools are offered only where a shell of this session's could exist at all: enabled on the gateway, host cwd
    // engine. The write tools need, on top, the gateway's say-so and a session an operator created; both are read
    // afresh on every build, so a record never carries a stale grant.
    const config: SessionRunnerConfig = {
      ...built,
      ...(deps.peers ? { peers: deps.peers } : {}),
      ...(deps.pricing ? { pricing: deps.pricing } : {}),
    }
    delete config.contextReset
    delete config.avatar
    delete config.shells
    delete config.shellAgentWrite
    delete config.effortDefaults
    const efforts = { ...deps.effortDefaults, ...profile?.defaults?.efforts }
    if (Object.keys(efforts).length > 0) {
      config.effortDefaults = efforts
    }
    if (deps.contextReset && (built.agentContextReset ?? profile?.defaults?.agentContextReset ?? deps.contextReset.defaultEnabled)) {
      config.contextReset = deps.contextReset.directory
    }
    if (deps.shells && capabilities.hostCwd === true) {
      config.shells = deps.shells
      const write = deps.shellAgentWrite ?? 'read-only'
      if (write !== 'read-only' && built.createdByOperator === true) {
        config.shellAgentWrite = write
      }
    }
    if (deps.avatar && (options?.agent === true || deps.avatar.isAgent(id ?? restore?.id))) {
      config.avatar = deps.avatar.directory
    }
    const brief = options?.brief ?? deps.agentBrief?.(id ?? restore?.id)
    if (brief) {
      config.instructions = composeInstructions(config.instructions, brief)
    }
    if (config.instructions !== undefined && capabilities.systemInstructions === false) {
      throw new Error(`the ${engineOf(profile)} engine cannot deliver system instructions`)
    }
    const runner =
      profile && isProviderProfile(profile)
        ? // Non-null: startup refuses a provider profile when no factory was wired.
          await deps.createEngineRunner!({ config, profile, bridge, restore, id })
        : // The in-repo adapters refuse `restore` themselves - neither binary can rebuild a parked session.
          await adapterFor(profile?.engine).createRunner({ config, profile, restore, id })
    const reported = runner.info().scope
    if (!sameScope(reported, config.scope)) {
      throw new Error(
        `runner for session ${runner.id} reports scope ${JSON.stringify(reported)}, ` +
          `expected ${JSON.stringify(config.scope)} - echo config.scope from info()`,
      )
    }
    return runner
  }

  const createRunner = async (config: SessionRunnerConfig, options?: BuildOptions): Promise<Runner> => {
    const runner = registry.register(await buildRunner(config, undefined, undefined, options))
    // Watchers first, then start: a session must not emit anything before the things that persist and account for it are listening.
    parking.remember(runner.id, config)
    parking.watch(runner)
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
    // One profile needs no naming, and neither does a set that still carries the auto-detected
    // `default` - otherwise choosing is the caller's, because a profile is a credential store.
    const effective = name ?? (all.length === 1 ? all[0]!.name : all.find((p) => p.name === 'default')?.name)
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

  const watchAuthSource = (runner: Runner): (() => void) => {
    let seen = false
    return runner.subscribe((event) => {
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
            "requires an API key under Anthropic's terms - set ANTHROPIC_API_KEY in the " +
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
