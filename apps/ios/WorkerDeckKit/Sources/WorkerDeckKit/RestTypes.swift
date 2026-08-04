import Foundation

// Swift mirror of the protocol's REST shapes (sessions, profiles, SDK sessions,
// files). The job-queue surface is not mirrored yet — it is a later phase of the
// mobile plan; add it here (from packages/protocol) when the app grows a jobs view.

// MARK: - Profiles

public enum ProfileEngine: String, Codable, Sendable {
  case claude
  case provider
}

/// Permission modes the model-agnostic provider engine understands.
public let providerPermissionModes: [PermissionMode] = [.default, .bypassPermissions, .dontAsk]

/// Whether a profile's engine can run a permission mode. An absent `engine`
/// means 'claude' (every mode).
public func supportsPermissionMode(engine: ProfileEngine?, mode: PermissionMode) -> Bool {
  engine == .provider ? providerPermissionModes.contains(mode) : true
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
  public let provider: ProviderConfig?
  public let description: String?
  public let defaults: ProfileDefaults?
  public let session: ProfileSessionDefaults?
  /// Response-only: store-backed and editable through the API.
  public let managed: Bool?

  public var id: String { name }
  public var resolvedEngine: ProfileEngine { engine ?? .claude }

  public init(
    name: String, engine: ProfileEngine? = nil, configDir: String? = nil,
    provider: ProviderConfig? = nil, description: String? = nil,
    defaults: ProfileDefaults? = nil, session: ProfileSessionDefaults? = nil,
    managed: Bool? = nil
  ) {
    self.name = name
    self.engine = engine
    self.configDir = configDir
    self.provider = provider
    self.description = description
    self.defaults = defaults
    self.session = session
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
  public let model: String?
  public let permissionMode: PermissionMode?
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
  /// Epoch ms of the most recent emitted event.
  public let lastActivityAt: Double?

  public var resolvedEngine: ProfileEngine { engine ?? .claude }

  public init(
    id: String, sdkSessionId: String? = nil, status: SessionStatus, cwd: String,
    profile: String? = nil, engine: ProfileEngine? = nil, model: String? = nil,
    permissionMode: PermissionMode? = nil, apiKeySource: String? = nil,
    createdAt: Double, lastSeq: Int, pendingPermissionCount: Int,
    meta: [String: JSONValue]? = nil, title: String? = nil, totalCostUsd: Double? = nil,
    numTurns: Int? = nil, lastActivityAt: Double? = nil
  ) {
    self.id = id
    self.sdkSessionId = sdkSessionId
    self.status = status
    self.cwd = cwd
    self.profile = profile
    self.engine = engine
    self.model = model
    self.permissionMode = permissionMode
    self.apiKeySource = apiKeySource
    self.createdAt = createdAt
    self.lastSeq = lastSeq
    self.pendingPermissionCount = pendingPermissionCount
    self.meta = meta
    self.title = title
    self.totalCostUsd = totalCostUsd
    self.numTurns = numTurns
    self.lastActivityAt = lastActivityAt
  }
}

public enum SettingSource: String, Codable, Sendable {
  case user
  case project
  case local
}

public struct CreateSessionRequest: Encodable, Sendable {
  /// Directory the session is rooted at. Required.
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
    resume: String? = nil, forkSession: Bool? = nil, includePartialMessages: Bool? = nil,
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

public struct ListSdkSessionsResponse: Decodable, Sendable {
  public let sdkSessions: [SdkSessionSummary]
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
