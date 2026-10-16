import Foundation

public struct AgentRef: Codable, Sendable, Equatable, Hashable {
  public let id: String
  public let name: String
  public let avatar: String?
  public let lead: String?
  public let leadGateway: String?
  public let team: String?
  public let leads: Bool?
  public let shared: Bool?
  public let order: Double?
  public let conversation: Int?

  public init(
    id: String, name: String, avatar: String? = nil, lead: String? = nil,
    leadGateway: String? = nil, team: String? = nil, leads: Bool? = nil, shared: Bool? = nil,
    order: Double? = nil, conversation: Int? = nil
  ) {
    self.id = id
    self.name = name
    self.avatar = avatar
    self.lead = lead
    self.leadGateway = leadGateway
    self.team = team
    self.leads = leads
    self.shared = shared
    self.order = order
    self.conversation = conversation
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    avatar = try? c.decodeIfPresent(String.self, forKey: .avatar)
    lead = try? c.decodeIfPresent(String.self, forKey: .lead)
    leadGateway = try? c.decodeIfPresent(String.self, forKey: .leadGateway)
    team = try? c.decodeIfPresent(String.self, forKey: .team)
    leads = try? c.decodeIfPresent(Bool.self, forKey: .leads)
    shared = try? c.decodeIfPresent(Bool.self, forKey: .shared)
    order = try? c.decodeIfPresent(Double.self, forKey: .order)
    conversation = try? c.decodeIfPresent(Int.self, forKey: .conversation)
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, avatar, lead, leadGateway, team, leads, shared, order, conversation
  }

  public var isLead: Bool { leads == true }
  public var isMember: Bool { lead != nil }
}

public struct StatusLabel: Codable, Sendable, Equatable, Hashable {
  public let text: String
  public let emoji: String?
  public let setAt: Double

  public init(text: String, emoji: String? = nil, setAt: Double) {
    self.text = text
    self.emoji = emoji
    self.setAt = setAt
  }
}

public func statusLine(_ label: StatusLabel?) -> String? {
  guard let label else { return nil }
  if let emoji = label.emoji, !emoji.isEmpty { return "\(emoji) \(label.text)" }
  return label.text
}

public enum AgentSharing: String, Codable, Sendable, CaseIterable {
  case `private`, shared
}

public struct AgentConfig: Codable, Sendable, Equatable {
  public var cwd: String?
  public var profile: String?
  public var model: String?
  public var reasoningEffort: String?
  public var permissionMode: PermissionMode?
  public var brief: String?
  public var agentContextReset: Bool?
  public var sleepAfterMs: Double?

  public init(
    cwd: String? = nil, profile: String? = nil, model: String? = nil,
    reasoningEffort: String? = nil, permissionMode: PermissionMode? = nil, brief: String? = nil,
    agentContextReset: Bool? = nil, sleepAfterMs: Double? = nil
  ) {
    self.cwd = cwd
    self.profile = profile
    self.model = model
    self.reasoningEffort = reasoningEffort
    self.permissionMode = permissionMode
    self.brief = brief
    self.agentContextReset = agentContextReset
    self.sleepAfterMs = sleepAfterMs
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
    profile = try c.decodeIfPresent(String.self, forKey: .profile)
    model = try c.decodeIfPresent(String.self, forKey: .model)
    reasoningEffort = try c.decodeIfPresent(String.self, forKey: .reasoningEffort)
    permissionMode = try? c.decodeIfPresent(PermissionMode.self, forKey: .permissionMode)
    brief = try c.decodeIfPresent(String.self, forKey: .brief)
    agentContextReset = try c.decodeIfPresent(Bool.self, forKey: .agentContextReset)
    sleepAfterMs = try c.decodeIfPresent(Double.self, forKey: .sleepAfterMs)
  }

  private enum CodingKeys: String, CodingKey {
    case cwd, profile, model, reasoningEffort, permissionMode, brief, agentContextReset,
      sleepAfterMs
  }
}

public struct AgentInfo: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  public let owner: String?
  public let sharing: AgentSharing?
  public let createdAt: Double
  public let updatedAt: Double?
  public let avatar: String?
  public let sessionId: String?
  public let pastSessions: [String]
  public let config: AgentConfig
  public let lead: String?
  public let order: Double?

  public init(
    id: String, name: String, owner: String? = nil, sharing: AgentSharing? = nil,
    createdAt: Double, updatedAt: Double? = nil, avatar: String? = nil, sessionId: String? = nil,
    pastSessions: [String] = [], config: AgentConfig = AgentConfig(), lead: String? = nil,
    order: Double? = nil
  ) {
    self.id = id
    self.name = name
    self.owner = owner
    self.sharing = sharing
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.avatar = avatar
    self.sessionId = sessionId
    self.pastSessions = pastSessions
    self.config = config
    self.lead = lead
    self.order = order
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    owner = try c.decodeIfPresent(String.self, forKey: .owner)
    sharing = try? c.decodeIfPresent(AgentSharing.self, forKey: .sharing)
    createdAt = try c.decode(Double.self, forKey: .createdAt)
    updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt)
    avatar = try c.decodeIfPresent(String.self, forKey: .avatar)
    sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
    pastSessions = try c.decodeIfPresent([String].self, forKey: .pastSessions) ?? []
    config = try c.decodeIfPresent(AgentConfig.self, forKey: .config) ?? AgentConfig()
    lead = try c.decodeIfPresent(String.self, forKey: .lead)
    order = try c.decodeIfPresent(Double.self, forKey: .order)
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, owner, sharing, createdAt, updatedAt, avatar, sessionId, pastSessions, config,
      lead, order
  }
}

public struct AgentResponse: Decodable, Sendable {
  public let agent: AgentInfo
  public let session: SessionInfo?
}
