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

public struct CreateAgentRequest: Encodable, Sendable {
  public var name: String?
  public var config: AgentConfig?
  public var prompt: String?
  public var lead: String?
  public var adopt: String?
  public var sharing: AgentSharing?
  public var crossOwner: Bool?

  public init(
    name: String? = nil, config: AgentConfig? = nil, prompt: String? = nil, lead: String? = nil,
    adopt: String? = nil, sharing: AgentSharing? = nil, crossOwner: Bool? = nil
  ) {
    self.name = name
    self.config = config
    self.prompt = prompt
    self.lead = lead
    self.adopt = adopt
    self.sharing = sharing
    self.crossOwner = crossOwner
  }
}

// `lead` is three-state on the wire: an id joins, an explicit null leaves, absent keeps the team as is.
public struct UpdateAgentRequest: Encodable, Sendable {
  public enum LeadEdit: Sendable, Equatable {
    case join(String)
    case leave
  }

  public var name: String?
  public var lead: LeadEdit?
  public var order: Double?
  public var sharing: AgentSharing?
  public var crossOwner: Bool?

  public init(
    name: String? = nil, lead: LeadEdit? = nil, order: Double? = nil,
    sharing: AgentSharing? = nil, crossOwner: Bool? = nil
  ) {
    self.name = name
    self.lead = lead
    self.order = order
    self.sharing = sharing
    self.crossOwner = crossOwner
  }

  private enum CodingKeys: String, CodingKey { case name, lead, order, sharing, crossOwner }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(name, forKey: .name)
    switch lead {
    case .join(let id): try c.encode(id, forKey: .lead)
    case .leave: try c.encodeNil(forKey: .lead)
    case nil: break
    }
    try c.encodeIfPresent(order, forKey: .order)
    try c.encodeIfPresent(sharing, forKey: .sharing)
    try c.encodeIfPresent(crossOwner, forKey: .crossOwner)
  }
}

public enum RetireMembers: String, Encodable, Sendable {
  case release, retire
}

public struct RetireAgentRequest: Encodable, Sendable {
  public var members: RetireMembers?

  public init(members: RetireMembers? = nil) {
    self.members = members
  }
}

public struct RetireAgentResponse: Decodable, Sendable, Equatable {
  public let retired: [String]
  public let released: [String]
}

public struct AgentResponse: Decodable, Sendable {
  public let agent: AgentInfo
  public let session: SessionInfo?
}

public struct AgentsResponse: Decodable, Sendable {
  public let agents: [AgentInfo]
}

public struct AgentAvatarImage: Sendable, Equatable {
  public let data: Data
  public let durations: [Double]?

  public init(data: Data, durations: [Double]? = nil) {
    self.data = data
    self.durations = durations
  }
}

public func frameDurations(_ header: String?) -> [Double]? {
  guard let header, !header.isEmpty else { return nil }
  let durations = header.split(separator: ",").compactMap {
    Double($0.trimmingCharacters(in: .whitespaces))
  }.filter { $0.isFinite && $0 > 0 }
  return durations.isEmpty ? nil : durations
}

public struct GatewayRelayMeta: Decodable, Sendable, Equatable {
  public let gateway: String
  public let owner: String?
  public let online: Bool
  public let features: [String]

  public init(gateway: String, owner: String? = nil, online: Bool, features: [String] = []) {
    self.gateway = gateway
    self.owner = owner
    self.online = online
    self.features = features
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    gateway = try c.decode(String.self, forKey: .gateway)
    owner = try c.decodeIfPresent(String.self, forKey: .owner)
    online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
    features = try c.decodeIfPresent([String].self, forKey: .features) ?? []
  }

  private enum CodingKeys: String, CodingKey { case gateway, owner, online, features }
}

public struct GatewayAgentDefaults: Decodable, Sendable, Equatable {
  public let owner: String?
  public let multiOwner: Bool?
  public let sharing: AgentSharing?
  public let allowShared: Bool?

  public init(
    owner: String? = nil, multiOwner: Bool? = nil, sharing: AgentSharing? = nil,
    allowShared: Bool? = nil
  ) {
    self.owner = owner
    self.multiOwner = multiOwner
    self.sharing = sharing
    self.allowShared = allowShared
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    owner = try c.decodeIfPresent(String.self, forKey: .owner)
    multiOwner = try c.decodeIfPresent(Bool.self, forKey: .multiOwner)
    sharing = try? c.decodeIfPresent(AgentSharing.self, forKey: .sharing)
    allowShared = try c.decodeIfPresent(Bool.self, forKey: .allowShared)
  }

  private enum CodingKeys: String, CodingKey { case owner, multiOwner, sharing, allowShared }
}

public struct GatewayMeta: Decodable, Sendable, Equatable {
  public let protocolVersion: Int
  public let machineId: String?
  public let relay: GatewayRelayMeta?
  public let agents: GatewayAgentDefaults?

  public init(
    protocolVersion: Int, machineId: String? = nil, relay: GatewayRelayMeta? = nil,
    agents: GatewayAgentDefaults? = nil
  ) {
    self.protocolVersion = protocolVersion
    self.machineId = machineId
    self.relay = relay
    self.agents = agents
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try c.decode(Int.self, forKey: .protocolVersion)
    machineId = try c.decodeIfPresent(String.self, forKey: .machineId)
    relay = try? c.decodeIfPresent(GatewayRelayMeta.self, forKey: .relay)
    agents = try? c.decodeIfPresent(GatewayAgentDefaults.self, forKey: .agents)
  }

  private enum CodingKeys: String, CodingKey { case protocolVersion, machineId, relay, agents }
}
