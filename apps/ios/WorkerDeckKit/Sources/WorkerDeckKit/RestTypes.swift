import Foundation

// Swift mirror of the protocol's REST shapes (sessions, profiles, SDK sessions,
// files). The job-queue surface is not mirrored yet — it is a later phase of the
// mobile plan; add it here (from packages/protocol) when the app grows a jobs view.

// MARK: - Profiles

/// A closed union, deliberately — adding a member is a versioned protocol event
/// and the app ships in lockstep with the gateway (exact version compare).
public enum ProfileEngine: String, Codable, Sendable {
  case claude
  case codex
  case provider
}

/// What an engine does and does not do — mirror of the protocol's
/// `EngineCapabilities`. Render from this record instead of switching on the
/// engine name: a false/absent capability means the affordance is *hidden*,
/// never a control that silently does nothing.
///
/// Lenient on the open-ended axes (`attachments`, `streaming`,
/// `reasoningEfforts` stay strings; unknown permission modes are dropped), so a
/// record from a slightly newer server degrades instead of failing the decode.
public struct EngineCapabilities: Codable, Sendable, Equatable {
  public let interactiveApprovals: Bool
  public let permissionModes: [PermissionMode]
  public let defaultPermissionMode: PermissionMode
  public let resume: Bool
  public let resumeBackfill: Bool
  public let listSessions: Bool
  public let contextUsage: Bool
  public let rateLimits: Bool
  public let mcpStatus: Bool
  /// Whether the engine can reconnect/enable/disable ONE server. Separate from
  /// `mcpStatus` because listing and acting are different powers: codex reports
  /// rich status but exposes no per-server action, and buttons that 501 are
  /// worse than buttons that aren't there.
  public let mcpServerActions: Bool
  public let sessionMcpServers: Bool
  public let slashCommands: Bool
  /// `skills` events can occur. False: hide the skills panel entirely rather
  /// than showing an empty one. Orthogonal to `slashCommands` — codex has
  /// skills and no commands; claude has commands and no listable skills.
  public let skillsList: Bool
  public let settingSources: Bool
  public let budgets: Bool
  /// 'image' | 'pdf' | 'text' — open strings; filter the attach menu by the ones
  /// this build knows.
  public let attachments: [String]
  /// Absent = the effort control is not offered.
  public let reasoningEfforts: [String]?
  public let vfs: Bool
  /// The engine runs against a host directory, so a create must name a `cwd`.
  /// Absent = true (an older gateway), which is the always-required behaviour.
  public let hostCwd: Bool?
  /// 'token' | 'item' | 'none' — anything ≠ 'token' renders without a typing cursor.
  public let streaming: String

  public init(
    interactiveApprovals: Bool, permissionModes: [PermissionMode],
    defaultPermissionMode: PermissionMode, resume: Bool, resumeBackfill: Bool,
    listSessions: Bool, contextUsage: Bool, rateLimits: Bool, mcpStatus: Bool,
    mcpServerActions: Bool = false,
    sessionMcpServers: Bool, slashCommands: Bool, skillsList: Bool = false,
    settingSources: Bool, budgets: Bool,
    attachments: [String], reasoningEfforts: [String]? = nil, vfs: Bool,
    hostCwd: Bool? = nil, streaming: String
  ) {
    self.interactiveApprovals = interactiveApprovals
    self.permissionModes = permissionModes
    self.defaultPermissionMode = defaultPermissionMode
    self.resume = resume
    self.resumeBackfill = resumeBackfill
    self.listSessions = listSessions
    self.contextUsage = contextUsage
    self.rateLimits = rateLimits
    self.mcpStatus = mcpStatus
    self.mcpServerActions = mcpServerActions
    self.sessionMcpServers = sessionMcpServers
    self.slashCommands = slashCommands
    self.skillsList = skillsList
    self.settingSources = settingSources
    self.budgets = budgets
    self.attachments = attachments
    self.reasoningEfforts = reasoningEfforts
    self.vfs = vfs
    self.hostCwd = hostCwd
    self.streaming = streaming
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    interactiveApprovals = try c.decode(Bool.self, forKey: .interactiveApprovals)
    // Unknown mode strings are a newer server's vocabulary — drop them rather
    // than fail the decode; this build could not offer them anyway.
    let rawModes = try c.decode([String].self, forKey: .permissionModes)
    permissionModes = rawModes.compactMap { PermissionMode(rawValue: $0) }
    defaultPermissionMode =
      PermissionMode(rawValue: try c.decode(String.self, forKey: .defaultPermissionMode))
      ?? .default
    resume = try c.decode(Bool.self, forKey: .resume)
    resumeBackfill = try c.decode(Bool.self, forKey: .resumeBackfill)
    listSessions = try c.decode(Bool.self, forKey: .listSessions)
    contextUsage = try c.decode(Bool.self, forKey: .contextUsage)
    rateLimits = try c.decode(Bool.self, forKey: .rateLimits)
    mcpStatus = try c.decode(Bool.self, forKey: .mcpStatus)
    // decodeIfPresent: a protocol-6 gateway has no such key, and "older server"
    // must read as "no action buttons", not as a failed decode.
    mcpServerActions = try c.decodeIfPresent(Bool.self, forKey: .mcpServerActions) ?? false
    sessionMcpServers = try c.decode(Bool.self, forKey: .sessionMcpServers)
    slashCommands = try c.decode(Bool.self, forKey: .slashCommands)
    // decodeIfPresent, unlike its siblings: a protocol-6 gateway's record has
    // no such key, and "the server is older" must read as "no skills panel",
    // not as a failed decode of the whole session.
    skillsList = try c.decodeIfPresent(Bool.self, forKey: .skillsList) ?? false
    settingSources = try c.decode(Bool.self, forKey: .settingSources)
    budgets = try c.decode(Bool.self, forKey: .budgets)
    attachments = try c.decode([String].self, forKey: .attachments)
    reasoningEfforts = try c.decodeIfPresent([String].self, forKey: .reasoningEfforts)
    vfs = try c.decode(Bool.self, forKey: .vfs)
    // decodeIfPresent, and absent reads as `true`: an older gateway required a
    // cwd from everyone, so nil must not be mistaken for "no host filesystem".
    hostCwd = try c.decodeIfPresent(Bool.self, forKey: .hostCwd)
    streaming = try c.decode(String.self, forKey: .streaming)
  }
}

/// Mirror of the protocol's ENGINE_CAPABILITIES — the browser-safe default when
/// a `ProfileInfo`/`SessionInfo` carries no record of its own. When both exist,
/// the wire copy wins.
public let engineCapabilities: [ProfileEngine: EngineCapabilities] = [
  .claude: EngineCapabilities(
    interactiveApprovals: true,
    permissionModes: [.default, .acceptEdits, .bypassPermissions, .plan, .dontAsk, .auto],
    defaultPermissionMode: .default,
    resume: true, resumeBackfill: true, listSessions: true,
    contextUsage: true, rateLimits: true, mcpStatus: true, mcpServerActions: true,
    sessionMcpServers: true,
    slashCommands: true, skillsList: false, settingSources: true, budgets: true,
    attachments: ["image", "pdf", "text"],
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    vfs: false, streaming: "token"
  ),
  .codex: EngineCapabilities(
    // The app-server ask channels are wired to the permission surface. NOTE
    // the tense: codex's command approval is usually an escalation AFTER the
    // sandbox refused ("command failed; retry without sandbox?") — render the
    // request's own title/description rather than composing "wants to use X".
    interactiveApprovals: true,
    permissionModes: [.default, .acceptEdits, .bypassPermissions],
    defaultPermissionMode: .default,
    // A resume replays the thread's history as `replay: true` events, and
    // `GET /sdk-sessions?profile=` lists CODEX_HOME's threads — both true
    // since protocol 6's backfill landed.
    resume: true, resumeBackfill: true, listSessions: true,
    // contextUsage arrives with an empty `categories` — occupancy only, no
    // breakdown. ContextSheet hides its Breakdown section for that case.
    // `mcpServerStatus/list` answers with each server, its auth status and —
    // unlike the Agent SDK — every tool's full JSON Schema. Liveness rides the
    // `mcpServer/startupStatus/updated` notification, which the runner tracks.
    // No per-server action exists on this transport, hence read-only.
    contextUsage: true, rateLimits: true, mcpStatus: true, mcpServerActions: false,
    sessionMcpServers: false,
    // No command-listing RPC exists on the app-server surface at all; but
    // `skills/list` does, and `skills/changed` says when to re-read it.
    slashCommands: false, skillsList: true, settingSources: false, budgets: false,
    attachments: ["image", "text"],
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    vfs: false, streaming: "token"
  ),
  .provider: EngineCapabilities(
    interactiveApprovals: false,
    permissionModes: [.default, .bypassPermissions, .dontAsk],
    defaultPermissionMode: .default,
    resume: false, resumeBackfill: false, listSessions: false,
    contextUsage: false, rateLimits: false, mcpStatus: false, mcpServerActions: false,
    sessionMcpServers: false,
    slashCommands: false, skillsList: false, settingSources: false, budgets: false,
    attachments: ["image", "pdf", "text"], vfs: true, streaming: "token"
  ),
]

extension ProfileEngine {
  /// This engine's static capability record.
  public var defaultCapabilities: EngineCapabilities { engineCapabilities[self]! }
}

/// Permission modes the model-agnostic provider engine understands.
/// Deprecated spelling — read `ProfileEngine.provider.defaultCapabilities`.
public let providerPermissionModes: [PermissionMode] =
  engineCapabilities[.provider]!.permissionModes

/// Whether a profile's engine can run a permission mode. An absent `engine`
/// means 'claude' (every mode).
public func supportsPermissionMode(engine: ProfileEngine?, mode: PermissionMode) -> Bool {
  (engine ?? .claude).defaultCapabilities.permissionModes.contains(mode)
}

public enum SessionCapability: String, Codable, Sendable {
  case webSearch = "web_search"
  case download
  case webFetch = "web_fetch"
  case deliverFile = "deliver_file"
}

public struct ProfileDefaults: Codable, Sendable, Equatable {
  public let model: String?
  public let permissionMode: PermissionMode?

  public init(model: String? = nil, permissionMode: PermissionMode? = nil) {
    self.model = model
    self.permissionMode = permissionMode
  }
}

public struct ProviderConfig: Codable, Sendable, Equatable {
  /// Provider adapter, e.g. 'anthropic' | 'openai' | 'openai-compatible'. Host-extensible.
  public let id: String
  public let model: String?
  /// Model ids this profile offers, for pickers. Unset → offer `model` alone.
  public let models: [String]?
  public let baseUrl: String?
  /// Environment variable the operator put the key in. Never the key itself.
  public let apiKeyEnv: String?

  public init(
    id: String, model: String? = nil, models: [String]? = nil,
    baseUrl: String? = nil, apiKeyEnv: String? = nil
  ) {
    self.id = id
    self.model = model
    self.models = models
    self.baseUrl = baseUrl
    self.apiKeyEnv = apiKeyEnv
  }
}

public struct ProfileSessionDefaults: Codable, Sendable, Equatable {
  public let capabilities: [SessionCapability]?
  public let mcpServers: [String]?
  public let instructions: String?

  public init(
    capabilities: [SessionCapability]? = nil, mcpServers: [String]? = nil,
    instructions: String? = nil
  ) {
    self.capabilities = capabilities
    self.mcpServers = mcpServers
    self.instructions = instructions
  }
}

public struct ProfileInfo: Codable, Sendable, Equatable, Identifiable {
  /// Unique name, used as CreateSessionRequest.profile.
  public let name: String
  /// Defaults to 'claude' when absent.
  public let engine: ProfileEngine?
  public let configDir: String?
  /// Codex profiles: CODEX_HOME for the session's codex process (the `configDir`
  /// analogue). Unset = the binary's own `~/.codex`.
  public let codexHome: String?
  public let provider: ProviderConfig?
  public let description: String?
  public let defaults: ProfileDefaults?
  public let session: ProfileSessionDefaults?
  /// Response-only: the engine's model catalog, served from the first request.
  /// (For provider profiles the ids are in `provider.models` instead.)
  public let models: [ModelOption]?
  /// Response-only: what that profile's default model resolves to. Claude
  /// profiles: absent until a session on this profile reports it.
  public let defaultModel: String?
  /// Response-only: the engine's capability record. Absent = the engine's
  /// static default (`resolvedCapabilities` folds that in).
  public let capabilities: EngineCapabilities?
  /// Response-only: whether the profile's credentials probe as usable. Absent =
  /// unknown/unchecked — treat as available. Display-only either way.
  public let available: Bool?
  /// Response-only: one operator-actionable line when `available == false`.
  public let unavailableReason: String?
  /// Response-only: store-backed and editable through the API.
  public let managed: Bool?

  public var id: String { name }
  public var resolvedEngine: ProfileEngine { engine ?? .claude }
  /// The record to render from: the wire copy when the server stamped one, else
  /// the engine's static default.
  public var resolvedCapabilities: EngineCapabilities {
    capabilities ?? resolvedEngine.defaultCapabilities
  }
  /// Grey the row (and say why) only on an explicit false — absent is "unchecked".
  public var isUnavailable: Bool { available == false }

  public init(
    name: String, engine: ProfileEngine? = nil, configDir: String? = nil,
    codexHome: String? = nil,
    provider: ProviderConfig? = nil, description: String? = nil,
    defaults: ProfileDefaults? = nil, session: ProfileSessionDefaults? = nil,
    models: [ModelOption]? = nil, defaultModel: String? = nil,
    capabilities: EngineCapabilities? = nil, available: Bool? = nil,
    unavailableReason: String? = nil, managed: Bool? = nil
  ) {
    self.name = name
    self.engine = engine
    self.configDir = configDir
    self.codexHome = codexHome
    self.provider = provider
    self.description = description
    self.defaults = defaults
    self.session = session
    self.models = models
    self.defaultModel = defaultModel
    self.capabilities = capabilities
    self.available = available
    self.unavailableReason = unavailableReason
    self.managed = managed
  }
}

public struct ProfileConfigSnapshot: Decodable, Sendable, Equatable {
  public let settings: Settings?
  public let hasUserMemory: Bool
  public let skills: [String]
  public let agents: [String]
  public let commands: [String]

  public struct Settings: Decodable, Sendable, Equatable {
    public let model: String?
    public let defaultPermissionMode: String?
    public let permissionRules: PermissionRules?
    /// Env var NAMES only — values never leave the server.
    public let envKeys: [String]?
    public let hooks: [String]?

    public struct PermissionRules: Decodable, Sendable, Equatable {
      public let allow: Int
      public let ask: Int
      public let deny: Int
    }
  }
}

// MARK: - Sessions

public struct SessionInfo: Decodable, Sendable, Equatable, Identifiable {
  /// Server-assigned id (stable across SDK session forks/resumes).
  public let id: String
  /// Underlying Agent SDK session id, once known; use for `resume`.
  public let sdkSessionId: String?
  public let status: SessionStatus
  public let cwd: String
  public let profile: String?
  /// Engine actually running this session. Absent = 'claude'.
  public let engine: ProfileEngine?
  /// The engine's capability record, reported by the runner like `engine`. The
  /// attach snapshot is the session-level source — no event carries it.
  public let capabilities: EngineCapabilities?
  public let model: String?
  public let permissionMode: PermissionMode?
  /// Whether this session may be switched into `bypassPermissions` — decided when
  /// it was created and fixed for its lifetime. Absent (an older server) reads as
  /// unknown, and the picker offers the mode rather than hiding it.
  public let canBypassPermissions: Bool?
  /// 'oauth' = claude.ai subscription credentials. Kept as String.
  public let apiKeySource: String?
  /// Epoch ms.
  public let createdAt: Double
  /// Highest event seq emitted so far; attach with `afterSeq` to catch up.
  public let lastSeq: Int
  public let pendingPermissionCount: Int
  public let meta: [String: JSONValue]?
  /// Display title: meta.title if the host set one, else derived (e.g. first prompt).
  public let title: String?
  public let totalCostUsd: Double?
  public let numTurns: Int?
  /// How many transcript rows this session has produced (`transcriptActivity`'s
  /// unit) — a monotonic counter a client can diff against a remembered value to
  /// answer "how much happened while I wasn't looking", without attaching.
  /// `numTurns` cannot (five tool calls inside one turn are one turn) and
  /// `lastSeq` cannot either (it counts every stream delta). Absent on an older
  /// server; fall back to `numTurns` rather than showing nothing.
  public let activityCount: Int?
  /// Epoch ms of the most recent emitted event.
  public let lastActivityAt: Double?
  /// Opaque tags naming what this session belongs to. Assigned at create,
  /// immutable, and enforced by the gateway — a client only ever echoes them.
  public let scope: [String: String]?

  public var resolvedEngine: ProfileEngine { engine ?? .claude }
  /// The record to render from: the runner-reported copy when present, else the
  /// engine's static default.
  public var resolvedCapabilities: EngineCapabilities {
    capabilities ?? resolvedEngine.defaultCapabilities
  }

  public init(
    id: String, sdkSessionId: String? = nil, status: SessionStatus, cwd: String,
    profile: String? = nil, engine: ProfileEngine? = nil,
    capabilities: EngineCapabilities? = nil, model: String? = nil,
    permissionMode: PermissionMode? = nil, canBypassPermissions: Bool? = nil,
    apiKeySource: String? = nil,
    createdAt: Double, lastSeq: Int, pendingPermissionCount: Int,
    meta: [String: JSONValue]? = nil, title: String? = nil, totalCostUsd: Double? = nil,
    numTurns: Int? = nil, activityCount: Int? = nil, lastActivityAt: Double? = nil,
    scope: [String: String]? = nil
  ) {
    self.id = id
    self.sdkSessionId = sdkSessionId
    self.status = status
    self.cwd = cwd
    self.profile = profile
    self.engine = engine
    self.capabilities = capabilities
    self.model = model
    self.permissionMode = permissionMode
    self.canBypassPermissions = canBypassPermissions
    self.apiKeySource = apiKeySource
    self.createdAt = createdAt
    self.lastSeq = lastSeq
    self.pendingPermissionCount = pendingPermissionCount
    self.meta = meta
    self.title = title
    self.totalCostUsd = totalCostUsd
    self.numTurns = numTurns
    self.activityCount = activityCount
    self.lastActivityAt = lastActivityAt
    self.scope = scope
  }
}

public enum SettingSource: String, Codable, Sendable {
  case user
  case project
  case local
}

public struct CreateSessionRequest: Encodable, Sendable {
  /// Directory the session is rooted at. Optional on the wire — an engine whose
  /// capability record says `hostCwd: false` has no host filesystem — but kept
  /// required here: every session this app starts runs on a real machine.
  public var cwd: String
  /// Required when the server declares more than one profile.
  public var profile: String?
  /// Optional initial prompt (may be a skill invocation like "/wrapup").
  public var prompt: String?
  public var permissionMode: PermissionMode?
  /// Pre-authorize 'bypassPermissions' so the mode can be switched on mid-session.
  public var allowDangerouslySkipPermissions: Bool?
  public var allowedTools: [String]?
  public var disallowedTools: [String]?
  /// Passed through as raw config (stdio/http/sse shapes; see McpServerConfigWire
  /// in packages/protocol). Modeled as JSON for now — the app doesn't author these.
  public var mcpServers: [String: JSONValue]?
  /// Include 'project' to pick up the target repo's skills and CLAUDE.md.
  public var settingSources: [SettingSource]?
  public var model: String?
  public var maxTurns: Int?
  public var maxBudgetUsd: Double?
  /// Resume an existing SDK session by id.
  public var resume: String?
  /// With `resume`: fork to a new session id instead of continuing.
  public var forkSession: Bool?
  /// Reasoning effort for the session's model (codex engine). Only send when the
  /// profile's capability record declares `reasoningEfforts` — the gateway 400s
  /// it otherwise.
  public var reasoningEffort: String?
  /// Emit `stream_delta` events for token-by-token rendering. Server default true.
  public var includePartialMessages: Bool?
  public var approvalTimeoutMs: Double?
  public var questionBehavior: QuestionBehavior?
  /// Provider engine only: narrow the profile's capability grants.
  public var capabilities: [SessionCapability]?
  /// Free-form metadata echoed back on SessionInfo.
  public var meta: [String: JSONValue]?

  public init(
    cwd: String, profile: String? = nil, prompt: String? = nil,
    permissionMode: PermissionMode? = nil, allowDangerouslySkipPermissions: Bool? = nil,
    allowedTools: [String]? = nil, disallowedTools: [String]? = nil,
    mcpServers: [String: JSONValue]? = nil, settingSources: [SettingSource]? = nil,
    model: String? = nil, maxTurns: Int? = nil, maxBudgetUsd: Double? = nil,
    resume: String? = nil, forkSession: Bool? = nil, reasoningEffort: String? = nil,
    includePartialMessages: Bool? = nil,
    approvalTimeoutMs: Double? = nil, questionBehavior: QuestionBehavior? = nil,
    capabilities: [SessionCapability]? = nil, meta: [String: JSONValue]? = nil
  ) {
    self.cwd = cwd
    self.profile = profile
    self.prompt = prompt
    self.permissionMode = permissionMode
    self.allowDangerouslySkipPermissions = allowDangerouslySkipPermissions
    self.allowedTools = allowedTools
    self.disallowedTools = disallowedTools
    self.mcpServers = mcpServers
    self.settingSources = settingSources
    self.model = model
    self.maxTurns = maxTurns
    self.maxBudgetUsd = maxBudgetUsd
    self.resume = resume
    self.forkSession = forkSession
    self.reasoningEffort = reasoningEffort
    self.includePartialMessages = includePartialMessages
    self.approvalTimeoutMs = approvalTimeoutMs
    self.questionBehavior = questionBehavior
    self.capabilities = capabilities
    self.meta = meta
  }
}

// MARK: - SDK sessions (resume across server restarts)

public struct SdkSessionSummary: Decodable, Sendable, Equatable, Identifiable {
  public let sessionId: String
  /// Custom title, auto summary, or first prompt — whichever the SDK has.
  public let summary: String
  /// Epoch ms of last modification.
  public let lastModified: Double
  public let createdAt: Double?
  public let customTitle: String?
  public let firstPrompt: String?
  public let gitBranch: String?
  public let cwd: String?

  public var id: String { sessionId }
}

// MARK: - Session files (scratch VFS deliverables)

/// One deliverable in the session's scratch filesystem. The files routes 404 for
/// engines without a VFS (Claude-engine sessions).
public struct SessionFileInfo: Decodable, Sendable, Equatable, Identifiable {
  public let path: String
  public let bytes: Int

  public var id: String { path }
}

// MARK: - MCP (`/sessions/:id/mcp`)

/// One tool an MCP server exposes.
///
/// No parameter list: the CLI's status payload names and describes each tool but
/// does not carry its input schema, so the tool screen shows what it is, not how
/// to call it.
public struct McpServerToolInfo: Decodable, Sendable, Equatable, Identifiable {
  public let name: String
  public let description: String?
  public let annotations: Annotations?
  /// The tool's JSON Schema, where the engine reports one — **engine-dependent,
  /// and not an oversight**: codex's `mcpServerStatus/list` returns the full
  /// schema, the Agent SDK's equivalent carries none. Render parameters where
  /// they exist and say they are unavailable where they don't.
  public let inputSchema: JSONValue?

  public var id: String { name }

  public init(
    name: String, description: String? = nil, annotations: Annotations? = nil,
    inputSchema: JSONValue? = nil
  ) {
    self.name = name
    self.description = description
    self.annotations = annotations
    self.inputSchema = inputSchema
  }

  public struct Annotations: Decodable, Sendable, Equatable {
    public let readOnly: Bool?
    public let destructive: Bool?
    public let openWorld: Bool?

    public init(readOnly: Bool? = nil, destructive: Bool? = nil, openWorld: Bool? = nil) {
      self.readOnly = readOnly
      self.destructive = destructive
      self.openWorld = openWorld
    }
  }
}

/// Live status of one MCP server on a session.
///
/// The connection's identity only: the gateway drops the server's `env` and
/// HTTP `headers` before answering, so this can never become a way to read the
/// operator's API tokens off their own machine.
public struct McpServerStatusInfo: Decodable, Sendable, Equatable, Identifiable {
  public let name: String
  /// 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' — open set.
  public let status: String
  /// Where it was configured: 'project' | 'user' | 'local' | 'dynamic' | …
  public let scope: String?
  public let error: String?
  public let serverInfo: ServerInfo?
  /// 'stdio' | 'http' | 'sse' | 'sdk'
  public let transport: String?
  public let command: String?
  public let args: [String]?
  public let url: String?
  public let tools: [McpServerToolInfo]?

  public var id: String { name }

  public init(
    name: String, status: String, scope: String? = nil, error: String? = nil,
    serverInfo: ServerInfo? = nil, transport: String? = nil, command: String? = nil,
    args: [String]? = nil, url: String? = nil, tools: [McpServerToolInfo]? = nil
  ) {
    self.name = name
    self.status = status
    self.scope = scope
    self.error = error
    self.serverInfo = serverInfo
    self.transport = transport
    self.command = command
    self.args = args
    self.url = url
    self.tools = tools
  }

  public struct ServerInfo: Decodable, Sendable, Equatable {
    public let name: String
    public let version: String

    public init(name: String, version: String) {
      self.name = name
      self.version = version
    }
  }

  public var isConnected: Bool { status == "connected" }
  public var isDisabled: Bool { status == "disabled" }
  public var toolCount: Int { tools?.count ?? 0 }
}

/// `POST /sessions/:id/mcp/:name`.
public struct McpServerActionRequest: Encodable, Sendable, Equatable {
  public enum Action: String, Encodable, Sendable { case reconnect, enable, disable }
  public let action: Action

  public init(action: Action) { self.action = action }
}

// MARK: - Host filesystem (`/fs/*`)

/// One of the host directories this server will let a client browse.
///
/// Unrelated to `SessionFileInfo` despite both being "files": that is a
/// deliverable inside one session's in-memory VFS, this is the operator's real
/// disk. These routes are **operator-privileged** — the auth key authorizes them
/// outright, and they sit outside the agent permission flow on purpose. They are
/// also opt-in server-side: a server without roots configured 404s the whole
/// surface, which is what `HostFileAccess.unavailable` records.
public struct HostFileRoot: Decodable, Sendable, Equatable, Identifiable {
  /// Absolute, canonical (symlinks already resolved) path.
  public let path: String
  /// Last path segment, for display.
  public let name: String

  public var id: String { path }

  public init(path: String, name: String) {
    self.path = path
    self.name = name
  }
}

/// One entry in a host directory listing.
///
/// Classified with `lstat` semantics: a `symlink` is reported as itself and never
/// resolved here. Whether it *can* be followed is the next request's answer — the
/// server refuses one that escapes its roots.
public struct HostDirEntry: Decodable, Sendable, Equatable, Identifiable {
  public enum Kind: String, Decodable, Sendable, Equatable {
    case file, dir, symlink, other
  }

  public let name: String
  /// Absolute path, ready to pass straight back to `listHostDir`/`readHostFile`.
  public let path: String
  public let type: Kind
  /// Regular files only.
  public let bytes: Int?
  /// Epoch ms mtime.
  public let modifiedAt: Double?

  public var id: String { path }

  public init(
    name: String, path: String, type: Kind, bytes: Int? = nil, modifiedAt: Double? = nil
  ) {
    self.name = name
    self.path = path
    self.type = type
    self.bytes = bytes
    self.modifiedAt = modifiedAt
  }

  /// Unknown `type` strings decode as `.other` rather than failing the listing —
  /// a newer server adding a category must not blank the browser.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    name = try container.decode(String.self, forKey: .name)
    path = try container.decode(String.self, forKey: .path)
    type = Kind(rawValue: try container.decode(String.self, forKey: .type)) ?? .other
    bytes = try container.decodeIfPresent(Int.self, forKey: .bytes)
    modifiedAt = try container.decodeIfPresent(Double.self, forKey: .modifiedAt)
  }

  private enum CodingKeys: String, CodingKey {
    case name, path, type, bytes, modifiedAt
  }
}

/// One hit from `GET /fs/find` — the `@file` picker's unit.
public struct HostFileMatch: Decodable, Sendable, Equatable, Identifiable {
  /// Absolute path, for a follow-up read.
  public let path: String
  /// Path relative to the searched directory — what the picker shows and inserts.
  public let relative: String

  public var id: String { path }
}

/// Body of `PUT /fs/write`.
///
/// Always conditional: `expectedHash` is the hash from the read this edit is based
/// on, and its absence means "create". The server has no unconditional overwrite,
/// because the agent is editing the same tree.
public struct WriteHostFileRequest: Encodable, Sendable, Equatable {
  public let path: String
  public let content: String
  public let encoding: String?
  public let expectedHash: String?

  /// Write text. Pass the `hash` from the `ReadHostFileResponse` this edit started
  /// from; omit it only when creating a file that does not exist yet.
  public init(path: String, text: String, expectedHash: String?) {
    self.path = path
    self.content = text
    self.encoding = "utf8"
    self.expectedHash = expectedHash
  }

  public init(path: String, base64: String, expectedHash: String?) {
    self.path = path
    self.content = base64
    self.encoding = "base64"
    self.expectedHash = expectedHash
  }
}

// MARK: - Permission resolution over REST

/// Body of `POST /sessions/:id/permissions/:requestId` — the REST counterpart of
/// the WS `permission_decision` command (e.g. answering from a push notification).
public enum ResolvePermissionRequest: Sendable, Equatable {
  case allow(updatedInput: [String: JSONValue]? = nil)
  case deny(message: String? = nil, interrupt: Bool? = nil)
}

extension ResolvePermissionRequest: Encodable {
  private enum CodingKeys: String, CodingKey {
    case behavior, updatedInput, message, interrupt
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .allow(let updatedInput):
      try container.encode("allow", forKey: .behavior)
      try container.encodeIfPresent(updatedInput, forKey: .updatedInput)
    case .deny(let message, let interrupt):
      try container.encode("deny", forKey: .behavior)
      try container.encodeIfPresent(message, forKey: .message)
      try container.encodeIfPresent(interrupt, forKey: .interrupt)
    }
  }
}

/// Body of `PATCH /sessions/:id` — mirrors protocol's `UpdateSessionRequest`.
///
/// `title` is a three-state field and the encoding has to keep all three: a
/// string renames, an explicit `null` clears the override (restoring the derived
/// title), and *absent* leaves it alone. `String?` alone would collapse the last
/// two, so the wrapper spells the distinction out.
public struct UpdateSessionRequest: Encodable, Sendable {
  public enum TitleEdit: Sendable {
    case set(String)
    case clear
  }

  public let title: TitleEdit?

  public init(title: TitleEdit?) {
    self.title = title
  }

  private enum CodingKeys: String, CodingKey { case title }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch title {
    case .set(let value): try container.encode(value, forKey: .title)
    case .clear: try container.encodeNil(forKey: .title)
    case nil: break
    }
  }
}

// MARK: - Response envelopes

public struct ListSessionsResponse: Decodable, Sendable {
  public let sessions: [SessionInfo]
}

public struct SessionResponse: Decodable, Sendable {
  public let session: SessionInfo
}

public struct ListSessionFilesResponse: Decodable, Sendable {
  public let files: [SessionFileInfo]
}

public struct McpServersResponse: Decodable, Sendable {
  public let servers: [McpServerStatusInfo]
}

public struct UploadAttachmentResponse: Decodable, Sendable {
  public let attachment: MessageAttachment
}

public struct ListSdkSessionsResponse: Decodable, Sendable {
  public let sdkSessions: [SdkSessionSummary]
}

public struct ListHostRootsResponse: Decodable, Sendable, Equatable {
  public let roots: [HostFileRoot]
  /// Whether `PUT /fs/write` is enabled — hide the editor's save when false.
  public let canWrite: Bool
}

public struct ListHostDirResponse: Decodable, Sendable, Equatable {
  /// Canonical path actually listed, which may differ from the one requested.
  public let path: String
  /// Directories first, then files, each alphabetical.
  public let entries: [HostDirEntry]
  /// Set when the directory held more entries than the server returns.
  public let truncated: Bool?
}

public struct FindHostFilesResponse: Decodable, Sendable, Equatable {
  /// Canonical directory the search ran under; `relative` paths hang off it.
  public let base: String
  public let matches: [HostFileMatch]
  /// More matched, or the tree was larger than the server would walk.
  public let truncated: Bool
}

public struct ReadHostFileResponse: Decodable, Sendable, Equatable {
  public let path: String
  public let content: String
  /// `utf8` or `base64` — binary files come back base64 so an editor can decline
  /// to open them rather than corrupt them on save.
  public let encoding: String
  public let bytes: Int
  /// sha256 (hex) of the bytes on disk; carry it into the write that follows.
  public let hash: String
  public let modifiedAt: Double

  /// The contents as text, or nil when the server sent base64.
  public var text: String? { encoding == "utf8" ? content : nil }
}

public struct WriteHostFileResponse: Decodable, Sendable, Equatable {
  public let path: String
  public let bytes: Int
  /// Hash of what was just written — the `expectedHash` for the next edit.
  public let hash: String
  public let modifiedAt: Double
}

public struct ListProfilesResponse: Decodable, Sendable {
  public let profiles: [ProfileInfo]
  /// Whether this caller may create profiles here.
  public let canManage: Bool?
}

public struct GetProfileResponse: Decodable, Sendable {
  public let profile: ProfileInfo
  public let config: ProfileConfigSnapshot
}

public struct ErrorResponse: Decodable, Sendable {
  public let error: String
}
