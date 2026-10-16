import Foundation

// Swift mirror of the protocol's REST shapes (sessions, profiles, SDK sessions,
// files). The job-queue surface is not mirrored yet - it is a later phase of the
// mobile plan; add it here (from packages/protocol) when the app grows a jobs view.

// MARK: - Profiles

/// A closed union, deliberately - adding a member is a versioned protocol event
/// and the app ships in lockstep with the gateway (exact version compare).
public enum ProfileEngine: String, Codable, Sendable {
  case claude
  case codex
  case provider
}

/// What an engine does and does not do - mirror of the protocol's
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
  // 'all' | 'mcp' | 'none': which allowedTools/disallowedTools names the engine honours. Absent reads as 'all'.
  public let toolFilters: String
  public let slashCommands: Bool
  /// The `clear_context` session command is honored - offer the "Clear
  /// context" verb. Absent reads as false: hidden, never a button the server
  /// would ignore.
  public let clearContext: Bool
  /// `skills` events can occur. False: hide the skills panel entirely rather
  /// than showing an empty one. Orthogonal to `slashCommands` - codex has
  /// skills and no commands; claude has commands and no listable skills.
  public let skillsList: Bool
  public let settingSources: Bool
  public let budgets: Bool
  /// 'image' | 'pdf' | 'text' - open strings; filter the attach menu by the ones
  /// this build knows.
  public let attachments: [String]
  /// Absent = the effort control is not offered.
  public let reasoningEfforts: [String]?
  public let vfs: Bool
  /// The engine runs against a host directory, so a create must name a `cwd`.
  /// Absent = true, which is the always-required behaviour.
  public let hostCwd: Bool?
  /// The engine child can be stopped while the session stays live
  /// (`POST /sessions/:id/sleep`). Absent reads as false.
  public let engineSleep: Bool
  // A running foreground Bash or subagent call can be moved to the background. Absent reads as false.
  public let backgroundTasks: Bool
  /// 'token' | 'item' | 'none' - anything ≠ 'token' renders without a typing cursor.
  public let streaming: String

  public init(
    interactiveApprovals: Bool, permissionModes: [PermissionMode],
    defaultPermissionMode: PermissionMode, resume: Bool, resumeBackfill: Bool,
    listSessions: Bool, contextUsage: Bool, rateLimits: Bool, mcpStatus: Bool,
    mcpServerActions: Bool = false,
    sessionMcpServers: Bool, toolFilters: String = "all", slashCommands: Bool, clearContext: Bool = false,
    skillsList: Bool = false,
    settingSources: Bool, budgets: Bool,
    attachments: [String], reasoningEfforts: [String]? = nil, vfs: Bool,
    hostCwd: Bool? = nil, engineSleep: Bool = false, backgroundTasks: Bool = false,
    streaming: String
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
    self.toolFilters = toolFilters
    self.slashCommands = slashCommands
    self.clearContext = clearContext
    self.skillsList = skillsList
    self.settingSources = settingSources
    self.budgets = budgets
    self.attachments = attachments
    self.reasoningEfforts = reasoningEfforts
    self.vfs = vfs
    self.hostCwd = hostCwd
    self.engineSleep = engineSleep
    self.backgroundTasks = backgroundTasks
    self.streaming = streaming
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    interactiveApprovals = try c.decode(Bool.self, forKey: .interactiveApprovals)
    // Unknown mode strings are a newer server's vocabulary - drop them rather
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
    mcpServerActions = try c.decode(Bool.self, forKey: .mcpServerActions)
    sessionMcpServers = try c.decode(Bool.self, forKey: .sessionMcpServers)
    toolFilters = try c.decodeIfPresent(String.self, forKey: .toolFilters) ?? "all"
    slashCommands = try c.decode(Bool.self, forKey: .slashCommands)
    clearContext = try c.decodeIfPresent(Bool.self, forKey: .clearContext) ?? false
    skillsList = try c.decode(Bool.self, forKey: .skillsList)
    settingSources = try c.decode(Bool.self, forKey: .settingSources)
    budgets = try c.decode(Bool.self, forKey: .budgets)
    attachments = try c.decode([String].self, forKey: .attachments)
    reasoningEfforts = try c.decodeIfPresent([String].self, forKey: .reasoningEfforts)
    vfs = try c.decode(Bool.self, forKey: .vfs)
    hostCwd = try c.decodeIfPresent(Bool.self, forKey: .hostCwd)
    engineSleep = try c.decodeIfPresent(Bool.self, forKey: .engineSleep) ?? false
    backgroundTasks = try c.decodeIfPresent(Bool.self, forKey: .backgroundTasks) ?? false
    streaming = try c.decode(String.self, forKey: .streaming)
  }
}

/// Mirror of the protocol's ENGINE_CAPABILITIES - the browser-safe default when
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
    slashCommands: true, clearContext: true, skillsList: false, settingSources: true,
    budgets: true,
    attachments: ["image", "pdf", "text"],
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    vfs: false, engineSleep: true, backgroundTasks: true, streaming: "token"
  ),
  .codex: EngineCapabilities(
    // The app-server ask channels are wired to the permission surface. NOTE
    // the tense: codex's command approval is usually an escalation AFTER the
    // sandbox refused ("command failed; retry without sandbox?") - render the
    // request's own title/description rather than composing "wants to use X".
    interactiveApprovals: true,
    // `.auto` is codex's own "Approve for me" - workspace-write plus
    // `approvalsReviewer: "auto_review"`, routing approvals to codex's
    // risk-assessing subagent rather than to the user. Unlike the claude
    // engine's auto mode, that reviewer has no operator config surface.
    permissionModes: [.default, .acceptEdits, .bypassPermissions, .auto],
    defaultPermissionMode: .default,
    // A resume replays the thread's history as `replay: true` events, and
    // `GET /sdk-sessions?profile=` lists CODEX_HOME's threads - both true
    // since protocol 6's backfill landed.
    resume: true, resumeBackfill: true, listSessions: true,
    // contextUsage arrives with an empty `categories` - occupancy only, no
    // breakdown. ContextSheet hides its Breakdown section for that case.
    // `mcpServerStatus/list` answers with each server, its auth status and -
    // unlike the Agent SDK - every tool's full JSON Schema. Liveness rides the
    // `mcpServer/startupStatus/updated` notification, which the runner tracks.
    // No per-server action exists on this transport, hence read-only.
    contextUsage: true, rateLimits: true, mcpStatus: true, mcpServerActions: false,
    sessionMcpServers: true, toolFilters: "mcp",
    // No command-listing RPC exists on the app-server surface at all; but
    // `skills/list` does, and `skills/changed` says when to re-read it.
    slashCommands: false, clearContext: true, skillsList: true, settingSources: false,
    budgets: false,
    attachments: ["image", "text"],
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    vfs: false, engineSleep: true, streaming: "token"
  ),
  .provider: EngineCapabilities(
    interactiveApprovals: false,
    permissionModes: [.default, .bypassPermissions, .dontAsk],
    defaultPermissionMode: .default,
    resume: false, resumeBackfill: false, listSessions: false,
    // Host-wired MCP: the runner reports what the host assembled the session
    // from, so this engine can always answer - but never act on a connection.
    contextUsage: false, rateLimits: false, mcpStatus: true, mcpServerActions: false,
    sessionMcpServers: false, toolFilters: "none",
    slashCommands: false, clearContext: true, skillsList: false, settingSources: false,
    budgets: false,
    attachments: ["image", "pdf", "text"], vfs: true, streaming: "token"
  ),
]

extension ProfileEngine {
  /// This engine's static capability record.
  public var defaultCapabilities: EngineCapabilities { engineCapabilities[self]! }
}

// MARK: - Sessions

/// One sub-agent a session has spawned, as the *gateway* reconstructs it - the
/// stream carries no lifecycle events, only nested messages tagged with a
/// `parentToolUseId`, so this is a rollup the runner keeps and a client reads.
///
/// `status` is the sub-agent's **own** outcome, deliberately narrower than the
/// terminal theme's `taskFailed`, which reddens a `Task` row when any child
/// call failed. That is right for a transcript row you can expand - the failure
/// is one press away. It is wrong beside a session's name in a list, where a
/// grep that matched nothing inside an otherwise successful agent would read as
/// a failed run with nothing to open.
public struct SubagentInfo: Decodable, Sendable, Equatable, Identifiable {
  /// The `tool_use` id of the `Task` call that spawned it - the same id its
  /// nested events carry as `parentToolUseId`, and so the handle for jumping to
  /// that Task's row.
  public let toolUseId: String
  public var id: String { toolUseId }
  /// The Task input's `subagent_type` ("Explore"), when it named one.
  public let agentType: String?
  /// The Task input's short description. With `agentType` this is what tells two
  /// parallel sub-agents apart; a row reading only `Task` answers nothing.
  public let description: String?
  /// Set by an engine whose every record is a delegated agent, however it was
  /// named - Codex runs each one as its own thread and often has no name for it.
  public let isAgent: Bool?
  public let status: SubagentStatus
  /// Epoch ms the `Task` call was emitted.
  public let startedAt: Double
  /// Tool calls made so far - the progress reading while it runs.
  public let toolCount: Int
  /// The engine can stop this record's background task on request
  /// (`WorkerClient.stopTask`).
  public let stoppable: Bool?

  public init(
    toolUseId: String, agentType: String? = nil, description: String? = nil,
    isAgent: Bool? = nil, status: SubagentStatus, startedAt: Double, toolCount: Int,
    stoppable: Bool? = nil
  ) {
    self.toolUseId = toolUseId
    self.agentType = agentType
    self.description = description
    self.isAgent = isAgent
    self.status = status
    self.startedAt = startedAt
    self.toolCount = toolCount
    self.stoppable = stoppable
  }
}

public enum SubagentStatus: String, Decodable, Sendable, Equatable {
  case running
  case done
  case failed
}

// MARK: - Project identity

/// How a project asks to be drawn - mirror of the protocol's `ProjectIcon`.
///
/// `image` carries an **address, never bytes**: `SessionInfo` rides every row
/// of a list polled at 1.2s, so an inlined base64 icon would be paid for on
/// every poll of every session forever. The bytes are one
/// `WorkerClient.projectIcon(sessionId:)` fetch away, and `hash` (sha256 hex of
/// the bytes) is the cross-session cache key: two sessions in one project
/// serve identical bytes, so cache by hash - never by session - and fetch once
/// per project.
///
/// `glyph` is validated by *shape only* at the gateway (it has no icon
/// catalog), so a name this build does not recognise is expected input - draw
/// a generic folder mark for it, never an empty slot.
public enum ProjectIcon: Sendable, Equatable, Hashable {
  case glyph(name: String)
  case image(mediaType: MediaType, hash: String)

  /// Closed on the wire - the gateway's own classification emits only these
  /// two. A third value is a newer gateway's vocabulary, and it degrades to
  /// "no icon" in `ProjectInfo`'s decode rather than failing the session row.
  public enum MediaType: String, Decodable, Sendable, Equatable, Hashable {
    case png = "image/png"
    case svg = "image/svg+xml"
  }
}

extension ProjectIcon: Decodable {
  private enum CodingKeys: String, CodingKey {
    case type, name, mediaType, hash
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "glyph":
      self = .glyph(name: try c.decode(String.self, forKey: .name))
    case "image":
      self = .image(
        mediaType: try c.decode(MediaType.self, forKey: .mediaType),
        hash: try c.decode(String.self, forKey: .hash))
    default:
      // A newer gateway's arm. Throwing is what lets `ProjectInfo` degrade it
      // to nil - this build could not draw it anyway, and the alternative (an
      // `unknown` case) would make every renderer branch on a value that
      // means "pretend I am not here".
      throw DecodingError.dataCorruptedError(
        forKey: .type, in: c, debugDescription: "unknown project icon type")
    }
  }
}

/// Project identity for a session - what a `.workerdeck.json` in the session's
/// cwd ancestry declares, resolved by the **gateway** and shipped on
/// `SessionInfo.project`. The gateway reads the file, not each client: this
/// phone has no access to that filesystem, so a per-client reader would make
/// the feature exist on exactly one client.
public struct ProjectInfo: Decodable, Sendable, Equatable, Hashable {
  /// Display name - the file's `name`, else the root's basename. Never empty.
  public let name: String
  /// Canonical absolute path of the directory holding `.workerdeck.json`, on
  /// the *gateway's* filesystem - an opaque string to this client beyond
  /// equality and display. The grouping key, per gateway (see `projectKey` in
  /// `SessionList.swift`), and never `name`: two repos can both be called
  /// "api", and a rename must regroup nothing.
  public let root: String
  /// Absent = the file declared none, or declared one the gateway refused -
  /// malformed, escaping, oversized - which a client cannot and must not
  /// distinguish.
  public let icon: ProjectIcon?
  /// A 2 to 5 character abbreviation the file declared, validated by the
  /// gateway and absent when it refused one. List rows draw this instead of
  /// `name` when it is present; grouping never uses it.
  public let shortcode: String?

  public init(name: String, root: String, icon: ProjectIcon? = nil, shortcode: String? = nil) {
    self.name = name
    self.root = root
    self.icon = icon
    self.shortcode = shortcode
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    root = try c.decode(String.self, forKey: .root)
    // `try?`, deliberately: an icon this build cannot parse - a newer
    // gateway's third arm, a new media type - must read as "no icon", never
    // fail the decode of the whole `SessionInfo`. A display declaration must
    // not cost a session its row; same posture as `EngineCapabilities`'
    // unknown permission-mode strings.
    icon = try? c.decodeIfPresent(ProjectIcon.self, forKey: .icon)
    shortcode = try? c.decodeIfPresent(String.self, forKey: .shortcode)
  }

  private enum CodingKeys: String, CodingKey {
    case name, root, icon, shortcode
  }
}

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
  /// attach snapshot is the session-level source - no event carries it.
  public let capabilities: EngineCapabilities?
  public let model: String?
  // The effort the engine will send on its next request. nil = not known yet.
  public let effort: SessionEffort?
  public let permissionMode: PermissionMode?
  /// Whether this session may be switched into `bypassPermissions` - decided when
  /// it was created and fixed for its lifetime. Absent reads as unknown, and the
  /// picker offers the mode rather than hiding it.
  public let canBypassPermissions: Bool?
  /// 'oauth' = claude.ai subscription credentials. Kept as String.
  public let apiKeySource: String?
  /// Epoch ms.
  public let createdAt: Double
  /// Highest event seq emitted so far; attach with `afterSeq` to catch up.
  public let lastSeq: Int
  /// Which log `lastSeq` counts in. A dormant wake starts the session's log again from
  /// zero, so a seq kept across one - the one on a notification that sat on a lock screen -
  /// addresses a row that no longer exists. Absent on a gateway that predates the field and
  /// on a session that has never woken; **absent on either side means "same log"**, which is
  /// the behaviour this client had before it existed.
  public let epoch: Int?
  public let pendingPermissionCount: Int
  public let meta: [String: JSONValue]?
  /// Display title: meta.title if the host set one, else derived (e.g. first prompt).
  public let title: String?
  /// What the engine itself reported. Claude only, and absent everywhere else.
  public let totalCostUsd: Double?
  /// WorkerDeck's own figure, priced from `usageByModel`. Prefer it over
  /// `totalCostUsd` wherever a session's cost is drawn; absent on a gateway
  /// that predates the field, which is why every reader still falls back.
  public let costUsd: Double?
  public let numTurns: Int?
  /// How many transcript rows this session has produced (`transcriptActivity`'s
  /// unit) - a monotonic counter a client can diff against a remembered value to
  /// answer "how much happened while I wasn't looking", without attaching.
  /// `numTurns` cannot (five tool calls inside one turn are one turn) and
  /// `lastSeq` cannot either (it counts every stream delta).
  public let activityCount: Int?
  /// Rows of the kind a person is actually waiting to read - protocol's
  /// `transcriptProse`: assistant prose, a failed turn, an error, a delivered
  /// file, and nothing a sub-agent said to its parent. **This is the unread
  /// badge's unit**; `activityCount` stays "has anything happened at all",
  /// which is what sorting and dormancy read.
  public let proseCount: Int?
  /// Epoch ms of the most recent emitted event.
  public let lastActivityAt: Double?
  /// Sub-agents this session has running, plus a short tail of settled ones.
  ///
  /// Absent on an engine with no sidechains, and **absent and empty mean the
  /// same thing** - render nothing rather than "0 sub-agents". Bounded by the
  /// gateway (every running one, plus the newest settled ones): it rides every
  /// row of a list polled at 1.2s.
  public let subagents: [SubagentInfo]?
  /// The engine's own task checklist - Claude's `TodoWrite`, codex's plan.
  /// Absent and empty mean the same thing. A codex session that woke from
  /// dormancy reports none until its next plan update: thread history carries
  /// no plan notifications to rebuild from.
  public let checklist: [ChecklistItem]?
  /// Opaque tags naming what this session belongs to. Assigned at create,
  /// immutable, and enforced by the gateway - a client only ever echoes them.
  public let scope: [String: String]?
  /// Project identity discovered from the session's `cwd` - stamped by the
  /// **gateway at serve time** (runners never set it; a runner-echoed copy
  /// would be persisted into parking records and replay a stale name forever).
  /// Absent = no `.workerdeck.json` in the cwd's ancestry: render the folder
  /// basename.
  public let project: ProjectInfo?
  /// The session's latest context-window reading, served on the list so a row
  /// can show where a session is bloating **without attaching to it** - the same
  /// number the session screen's ring draws, retained by the runner from the
  /// last `context_usage` it emitted.
  ///
  /// **Absent is not zero.** A promptless session, a parked one from before the
  /// field existed, or an engine that reports no window has no reading: draw
  /// nothing, never an empty ring, which claims the context is empty rather than
  /// unknown.
  public let contextUsage: ContextReading?
  /// The session's tracked shells, decorated by the gateway: everything still
  /// running, plus non-zero exits for a while after. Absent and empty mean the
  /// same thing. `promotedShells` is what a list row draws from it - never the
  /// raw array, which carries shells too young to be worth a line.
  public let shells: [ShellInfo]?
  /// The engine child is stopped while the session stays live and listed; the
  /// next message resumes it. Absent = awake.
  public let engineAsleep: Bool?
  public let agent: AgentRef?
  public let owner: String?
  public let statusLabel: StatusLabel?

  public var resolvedEngine: ProfileEngine { engine ?? .claude }
  /// The record to render from: the runner-reported copy when present, else the
  /// engine's static default.
  public var resolvedCapabilities: EngineCapabilities {
    capabilities ?? resolvedEngine.defaultCapabilities
  }

  public init(
    id: String, sdkSessionId: String? = nil, status: SessionStatus, cwd: String,
    profile: String? = nil, engine: ProfileEngine? = nil,
    capabilities: EngineCapabilities? = nil, model: String? = nil, effort: SessionEffort? = nil,
    permissionMode: PermissionMode? = nil, canBypassPermissions: Bool? = nil,
    apiKeySource: String? = nil,
    createdAt: Double, lastSeq: Int, epoch: Int? = nil, pendingPermissionCount: Int,
    meta: [String: JSONValue]? = nil, title: String? = nil, totalCostUsd: Double? = nil,
    costUsd: Double? = nil,
    numTurns: Int? = nil, activityCount: Int? = nil, proseCount: Int? = nil,
    lastActivityAt: Double? = nil,
    subagents: [SubagentInfo]? = nil, checklist: [ChecklistItem]? = nil,
    scope: [String: String]? = nil,
    project: ProjectInfo? = nil, contextUsage: ContextReading? = nil,
    shells: [ShellInfo]? = nil, engineAsleep: Bool? = nil, agent: AgentRef? = nil,
    owner: String? = nil, statusLabel: StatusLabel? = nil
  ) {
    self.id = id
    self.sdkSessionId = sdkSessionId
    self.status = status
    self.cwd = cwd
    self.profile = profile
    self.engine = engine
    self.capabilities = capabilities
    self.model = model
    self.effort = effort
    self.permissionMode = permissionMode
    self.canBypassPermissions = canBypassPermissions
    self.apiKeySource = apiKeySource
    self.createdAt = createdAt
    self.lastSeq = lastSeq
    self.epoch = epoch
    self.pendingPermissionCount = pendingPermissionCount
    self.meta = meta
    self.title = title
    self.totalCostUsd = totalCostUsd
    self.costUsd = costUsd
    self.numTurns = numTurns
    self.activityCount = activityCount
    self.proseCount = proseCount
    self.lastActivityAt = lastActivityAt
    self.subagents = subagents
    self.checklist = checklist
    self.scope = scope
    self.project = project
    self.contextUsage = contextUsage
    self.shells = shells
    self.engineAsleep = engineAsleep
    self.agent = agent
    self.owner = owner
    self.statusLabel = statusLabel
  }
}

// MARK: - SDK sessions (resume across server restarts)

public struct SdkSessionSummary: Decodable, Sendable, Equatable, Identifiable {
  public let sessionId: String
  /// Custom title, auto summary, or first prompt - whichever the SDK has.
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

// MARK: - Response envelopes

public struct ListSessionsResponse: Decodable, Sendable {
  public let sessions: [SessionInfo]
}

public struct SessionResponse: Decodable, Sendable {
  public let session: SessionInfo
}

public struct ListSdkSessionsResponse: Decodable, Sendable {
  public let sdkSessions: [SdkSessionSummary]
}
