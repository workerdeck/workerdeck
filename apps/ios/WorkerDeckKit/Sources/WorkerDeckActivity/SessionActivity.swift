import Foundation

/// The wire contract between the CLI's APNs forwarder and the Live Activity on
/// the phone.
///
/// This is a *contract with the forwarder*, not part of the protocol
/// `WorkerDeckKit` mirrors - the same reasoning that keeps `DeviceRegistration`
/// out of the kit. It lives in its own module because two binaries must compile
/// the identical type: the app, which performs the intents, and the widget
/// extension, which draws the card.
///
/// The whole payload - `attributes` plus `content-state` plus APNs' own keys -
/// shares one 4 KB budget. The forwarder measures and shrinks; nothing here may
/// assume a field survived.
public struct SessionActivityAttributes: Sendable, Codable, Hashable {
  /// Stable for the life of the card. A rename mid-turn is a *content* change,
  /// which is why the title is not here.
  public let sessionId: String
  /// Which gateway raised this card, as the app's own opaque id for it. Absent
  /// from a device that registered before the app had one; the app then has to
  /// try every host when it reports the update token back.
  public let hostId: String?
  public let engine: String?
  public let cwdLeaf: String

  public init(sessionId: String, hostId: String? = nil, engine: String? = nil, cwdLeaf: String) {
    self.sessionId = sessionId
    self.hostId = hostId
    self.engine = engine
    self.cwdLeaf = cwdLeaf
  }

  public struct ContentState: Sendable, Codable, Hashable {
    /// One of `Phase`'s constants - but typed as `String` deliberately. A
    /// `Codable` enum throws on an unknown raw value, and ActivityKit drops the
    /// whole update when decoding throws: a newer gateway would freeze the card
    /// instead of degrading it. Same rule as `PushPayload.type`.
    public var phase: String
    public var title: String
    public var headline: String
    public var detail: String?
    /// Epoch **milliseconds**, never a `Date`. ActivityKit decodes pushed
    /// content state with a default `JSONDecoder`, whose date strategy counts
    /// seconds from 2001 - a Unix timestamp landing in a `Date` field draws a
    /// countdown from the wrong century. Numbers sidestep the strategy.
    public var startedAtMs: Double
    public var expiresAtMs: Double?
    public var pendingCount: Int
    public var steps: Steps?
    /// Running first, capped at `SessionActivityLimits.agents`. Absent from a
    /// gateway that predates the field, and the first thing the forwarder drops
    /// when a payload has to shrink: the card draws the line only when it came.
    public var agents: [Agent]?
    public var request: Request?
    /// Deep-link freight only; the card itself is keyed by `sessionId`, which
    /// survives a dormant wake. Same staleness contract as `PushPayload`.
    public var epoch: Int?
    public var seq: Int?
    /// Only ever written by an intent, locally, between the tap and the truth.
    /// Every push from the server carries `nil`, which is what clears it.
    public var decision: String?

    public init(
      phase: String,
      title: String,
      headline: String,
      detail: String? = nil,
      startedAtMs: Double,
      expiresAtMs: Double? = nil,
      pendingCount: Int = 0,
      steps: Steps? = nil,
      agents: [Agent]? = nil,
      request: Request? = nil,
      epoch: Int? = nil,
      seq: Int? = nil,
      decision: String? = nil
    ) {
      self.phase = phase
      self.title = title
      self.headline = headline
      self.detail = detail
      self.startedAtMs = startedAtMs
      self.expiresAtMs = expiresAtMs
      self.pendingCount = pendingCount
      self.steps = steps
      self.agents = agents
      self.request = request
      self.epoch = epoch
      self.seq = seq
      self.decision = decision
    }
  }

  public struct Steps: Sendable, Codable, Hashable {
    public var done: Int
    public var total: Int

    public init(done: Int, total: Int) {
      self.done = done
      self.total = total
    }
  }

  public struct Agent: Sendable, Codable, Hashable {
    public var name: String
    /// A `SubagentInfo.status` value: `running`, `done` or `failed`. `String`
    /// for the same reason `phase` is.
    public var state: String

    public init(name: String, state: String) {
      self.name = name
      self.state = state
    }
  }

  public struct Request: Sendable, Codable, Hashable {
    public var id: String
    /// A `RequestKind` constant, `String` for the same reason `phase` is.
    public var kind: String
    public var choices: [Choice]
    /// The original `PermissionRequest.input`, verbatim, when it fitted. An
    /// answer is encoded by *rewriting* that input, so without it the card can
    /// only offer "Answer in app" - which is exactly what an absent value means.
    public var inputJSON: String?

    public init(id: String, kind: String, choices: [Choice] = [], inputJSON: String? = nil) {
      self.id = id
      self.kind = kind
      self.choices = choices
      self.inputJSON = inputJSON
    }
  }

  public struct Choice: Sendable, Codable, Hashable {
    public var index: Int
    /// Truncated for drawing. The answer submitted is the full label read back
    /// out of `inputJSON`, so a clipped button never sends a clipped answer.
    public var label: String

    public init(index: Int, label: String) {
      self.index = index
      self.label = label
    }
  }
}

/// The phases the forwarder sends. Not an enum on the wire - see `phase`.
public enum SessionActivityPhase {
  public static let running = "running"
  public static let approval = "approval"
  public static let question = "question"
  public static let plan = "plan"
  public static let done = "done"
  public static let failed = "failed"
  public static let parked = "parked"
  public static let ended = "ended"

  /// Whether the card is waiting on a person. Written as a set membership so an
  /// unrecognised phase reads as "not waiting" rather than crashing a view.
  public static func isWaiting(_ phase: String) -> Bool {
    phase == approval || phase == question || phase == plan
  }

  /// Whether this is a final state the forwarder sent with `event: end`.
  public static func isFinal(_ phase: String) -> Bool {
    phase == done || phase == failed || phase == parked || phase == ended
  }
}

public enum SessionActivityRequestKind {
  public static let permission = "permission"
  public static let question = "question"
  public static let plan = "plan"
}

/// What an intent writes into `decision` while the server's answer is in flight.
public enum SessionActivityDecision {
  public static let sending = "sending"
  public static let sent = "sent"
  public static let gone = "gone"
  public static let parked = "parked"
  public static let failed = "failed"
  public static let locked = "locked"
}

/// Drawing budgets, shared so the forwarder's shrink loop and the views agree on
/// what "fits" means. The forwarder is what enforces them.
public enum SessionActivityLimits {
  public static let title = 60
  public static let headline = 120
  public static let detail = 200
  public static let choiceLabel = 40
  /// A layout budget under the lock screen's 160 pt, not a documented platform
  /// cap - Apple publishes no per-activity button count.
  public static let choices = 4
  /// Four names at roughly 55 wire bytes each, drawn as one line.
  public static let agents = 4
  public static let agentName = 24
}

/// One compact line about the session's sub-agents, and the count the Dynamic
/// Island has room for. Lives here rather than in the widget so `swift test`
/// covers the wording.
public enum SessionActivityAgents {
  public static let running = "running"
  public static let done = "done"
  public static let failed = "failed"

  public static func runningCount(_ agents: [SessionActivityAttributes.Agent]?) -> Int {
    (agents ?? []).filter { $0.state == running }.count
  }

  public static func summary(_ agents: [SessionActivityAttributes.Agent]?) -> String? {
    guard let agents, !agents.isEmpty else { return nil }
    let counts = [running, done, failed].map { state in agents.filter { $0.state == state }.count }
    var parts: [String] = []
    for (index, state) in [running, done, failed].enumerated() where counts[index] > 0 {
      let count = counts[index]
      let noun = parts.isEmpty ? " agent\(count == 1 ? "" : "s")" : ""
      parts.append("\(count)\(noun) \(state)")
    }
    // A state this build does not know is still an agent, so it counts rather than vanishing.
    return parts.isEmpty ? "\(agents.count) agent\(agents.count == 1 ? "" : "s")" : parts.joined(separator: " · ")
  }
}

// `canImport(ActivityKit)` alone is not enough: the module imports on macOS but
// `ActivityAttributes` is marked unavailable there, so the conformance fails to
// compile in `swift test`. The `os(iOS)` half is what keeps the Codable structs
// testable on the Mac while the conformance ships only where it exists.
#if canImport(ActivityKit) && os(iOS)
  import ActivityKit

  extension SessionActivityAttributes: ActivityAttributes {}
#endif
