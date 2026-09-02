import Foundation

/// The plan-usage rules both sides must agree on — a hand mirror of
/// `packages/protocol/src/usage.ts`. The semantics are the contract, not the
/// shape of the code: when that file changes, this one changes. Tests mirror
/// `packages/react/test/usage.test.ts`.

/// The transcript's own reading: the reducer's per-window map plus its **one**
/// clock for the whole map (the `ts` of the newest `rate_limit` event of any
/// window — see `TranscriptState.rateLimitsUpdatedAt`).
public struct SessionUsage: Sendable, Equatable {
  public let rateLimits: [String: RateLimitInfo]?
  public let updatedAt: Double?

  public init(rateLimits: [String: RateLimitInfo]? = nil, updatedAt: Double? = nil) {
    self.rateLimits = rateLimits
    self.updatedAt = updatedAt
  }
}

/// Which reading a client renders: the gateway's per-profile state wins every
/// window it holds, and the session's transcript fills the rest.
///
/// Deliberately **not** a timestamp comparison. The session side carries one
/// scalar clock for its whole map, so this session's morning `five_hour` is
/// dated by the afternoon's `seven_day` event and would beat a genuinely
/// fresher profile entry — while the tracker, fed by event `ts` from every
/// session on the profile, is never behind what one transcript holds. The
/// session half is coverage, not correctness: the tracker's memory is empty
/// after a gateway restart, and a session with no profile has no account state
/// at all.
public func mergeUsage(_ session: SessionUsage, _ profile: ProfileUsage?) -> ProfileUsage {
  var out: ProfileUsage = [:]
  for (key, info) in session.rateLimits ?? [:] {
    out[key] = ProfileUsageWindow(info: info, updatedAt: session.updatedAt ?? 0)
  }
  for (key, window) in profile ?? [:] {
    out[key] = window
  }
  return out
}

/// One row a usage meter draws, in the order `orderUsageWindows` fixed.
public struct UsageWindowRow: Sendable, Equatable, Identifiable {
  public let key: String
  public let info: RateLimitInfo
  /// Epoch ms; 0 means the reading came from a transcript with no clock —
  /// render no freshness line, not a date in 1970.
  public let updatedAt: Double
  /// See `ProfileUsageWindow.inferredReset` — say so, never infer locally.
  public let inferredReset: Bool

  public var id: String { key }

  public init(key: String, info: RateLimitInfo, updatedAt: Double = 0, inferredReset: Bool = false)
  {
    self.key = key
    self.info = info
    self.updatedAt = updatedAt
    self.inferredReset = inferredReset
  }
}

/// Reading order for the meters: the session window, the weekly window, then
/// whichever per-model weeklies exist, sorted by key. A window with no
/// `utilization` is unknown, not zero — dropped entirely rather than drawn as
/// an empty bar that reads as "plenty left".
public func orderUsageWindows(_ usage: ProfileUsage?) -> [UsageWindowRow] {
  let all = (usage ?? [:])
    .filter { $0.value.info.utilization != nil }
    .map { key, window in
      UsageWindowRow(
        key: key, info: window.info, updatedAt: window.updatedAt,
        inferredReset: window.inferredReset ?? false)
    }
  let named = ["five_hour", "seven_day"].flatMap { key in all.filter { $0.key == key } }
  let perModel = all.filter { $0.key.hasPrefix("seven_day_") }.sorted { $0.key < $1.key }
  return named + perModel
}

/// Flatten back to the per-window map every existing meter reads.
public func usageInfos(_ usage: ProfileUsage?) -> [String: RateLimitInfo]? {
  guard let usage else { return nil }
  return usage.mapValues(\.info)
}

/// How alarming a meter's reading is — the port of `meterSeverity` in
/// `packages/ui/src/lib/status.ts`.
///
/// The web draws two ramps off one percentage and they are deliberately not the
/// same: a **bar** reads as alarming later than a **number or a ring** does, so
/// the fill turns at 70/90 (`meterTintClass`, iOS `usageTint`) while everything
/// that reads as a value turns at 80/95. The session card's context ring is the
/// second kind, and drawing it off the bar ramp is how the phone came to show
/// blue-then-orange where the sidebar showed grey-then-amber for the same
/// session.
public enum MeterSeverity: String, Sendable, Equatable {
  case none
  case warning
  case error
}

public func meterSeverity(_ percentage: Double?) -> MeterSeverity {
  guard let percentage else { return .none }
  if percentage >= 95 { return .error }
  if percentage >= 80 { return .warning }
  return .none
}
