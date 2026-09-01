import Foundation

/// "What had you seen, and when" — per session, across relaunches.
///
/// A line-by-line port of `packages/protocol/src/watermarks.ts` — the semantics
/// are the contract, not the shape of the code. When the rules change there
/// (monotonicity, the once-a-minute touch, the 30-day prune, the rows-not-turns
/// arithmetic), they change here.
///
/// Two numbers because two surfaces ask different questions. A session list has
/// only the REST rollup for sessions it isn't showing, so it compares **rows the
/// gateway counted** (`SessionInfo.activityCount`); a session screen has the
/// whole transcript, so it compares **rows it rendered**. Keeping both means
/// neither surface has to attach to something it isn't rendering.
///
/// A watermark is only written while a session is genuinely on screen. A surface
/// nobody can see is not being read, and marking it read is how an unread badge
/// silently stops working.
public struct Watermark: Codable, Sendable, Equatable {
  /// Transcript rows seen (the reducer's `items.count`).
  public var itemCount: Int
  /// Rows the gateway had counted (`SessionInfo.activityCount`) — the same unit
  /// as `itemCount`, but from the rollup, so it is knowable for a session this
  /// client is not showing.
  public var activity: Int
  /// Prose rows seen (`SessionInfo.proseCount`) — the badge's unit. Optional
  /// because a mark stored before prose counting existed cannot say; see
  /// `unseenCount`, which reads that absence as "caught up" rather than
  /// badging a whole history the operator has already read.
  public var prose: Int?
  /// Completed turns seen. The fallback unit for a gateway too old to report
  /// `activityCount`; five tool calls in one turn count as one.
  public var turns: Int
  /// When this was last true (epoch ms).
  public var seenAt: Double

  public init(itemCount: Int, activity: Int, prose: Int? = nil, turns: Int, seenAt: Double) {
    self.itemCount = itemCount
    self.activity = activity
    self.prose = prose
    self.turns = turns
    self.seenAt = seenAt
  }
}

/// Where the marks are kept — a seam rather than a dependency, exactly like the
/// TS `WatermarkStore`: VS Code backs it with `globalState`, the dashboard with
/// `localStorage`, this app with `UserDefaults`, and none of them belongs here.
/// Reads happen once at construction; writes are whole-map and may be deferred —
/// nothing here awaits them.
public struct WatermarkStore {
  public var read: () -> [String: Watermark]?
  public var write: ([String: Watermark]) -> Void

  public init(
    read: @escaping () -> [String: Watermark]?,
    write: @escaping ([String: Watermark]) -> Void
  ) {
    self.read = read
    self.write = write
  }
}

/// Entries older than this are dropped on write — a session deleted months ago
/// should not keep a row in storage forever.
private let maxAgeMs: Double = 30 * 24 * 60 * 60 * 1000

/// How stale "last here" is allowed to get before a write happens anyway.
private let touchMs: Double = 60_000

public func watermarkKey(hostId: String, sessionId: String) -> String {
  "\(hostId):\(sessionId)"
}

public final class Watermarks {
  private let store: WatermarkStore
  private var cache: [String: Watermark]

  public init(store: WatermarkStore) {
    self.store = store
    cache = store.read() ?? [:]
  }

  public func get(hostId: String, sessionId: String) -> Watermark? {
    cache[watermarkKey(hostId: hostId, sessionId: sessionId)]
  }

  /// Every mark, for a caller deriving unread counts over a whole list.
  public func all() -> [String: Watermark] {
    cache
  }

  /// Record what is on screen now. Monotonic on purpose: a transcript that
  /// *shrank* (a compaction, a fresh attach mid-replay) must not walk the mark
  /// backwards and resurrect rows the user already read.
  ///
  /// Returns whether the mark actually moved, because an unread badge is
  /// computed from it and nothing else will say so: rows read on the session
  /// screen do not touch the sessions poll, so a caller that doesn't hear about
  /// this has no other way to learn the count is now wrong.
  @discardableResult
  public func mark(
    hostId: String, sessionId: String, itemCount: Int? = nil, activity: Int? = nil,
    prose: Int? = nil, turns: Int? = nil, now: Double = Date().timeIntervalSince1970 * 1000
  ) -> Bool {
    let id = watermarkKey(hostId: hostId, sessionId: sessionId)
    let previous = cache[id]
    // A caller with nothing to say about prose (an older gateway reports no
    // `proseCount`) must not overwrite a real mark with 0, which would re-badge
    // everything already read.
    let nextProse = prose.map { max(previous?.prose ?? 0, $0) } ?? previous?.prose
    let next = Watermark(
      itemCount: max(previous?.itemCount ?? 0, itemCount ?? 0),
      activity: max(previous?.activity ?? 0, activity ?? 0),
      prose: nextProse,
      turns: max(previous?.turns ?? 0, turns ?? 0),
      seenAt: now)
    if let previous,
      previous.itemCount == next.itemCount,
      previous.activity == next.activity,
      previous.prose == next.prose,
      previous.turns == next.turns,
      // Still worth a write once a minute so "last here" stays honest without
      // hammering storage on every streamed row.
      next.seenAt - previous.seenAt < touchMs
    {
      return false
    }
    cache[id] = next
    store.write(prune(now: now))
    return true
  }

  /// Forget a session — it was deleted, and its mark is now noise. A forget for
  /// something absent must not write: it would churn storage on every poll that
  /// sees a session already gone.
  public func forget(hostId: String, sessionId: String) {
    let id = watermarkKey(hostId: hostId, sessionId: sessionId)
    guard cache.removeValue(forKey: id) != nil else { return }
    store.write(cache)
  }

  private func prune(now: Double) -> [String: Watermark] {
    let cutoff = now - maxAgeMs
    for (id, mark) in cache where mark.seenAt < cutoff {
      cache.removeValue(forKey: id)
    }
    return cache
  }
}

/// Rows this client has not seen, from the rollup alone.
///
/// The unit is the best one the pair can agree on: **prose** the human has not
/// read (`proseCount`, scored by protocol's `transcriptProse`), else rows, else
/// turns. Prose is what the badge is *for* — a session that tool-loops for a
/// minute is working, not talking, and a count that ticks 6, 7, 8 through it is
/// noise. Rows stay the rung below for a gateway too old to report prose (turns
/// undercount badly — five tool calls in one turn is one turn — and a stream
/// sequence overcounts absurdly).
///
/// A session never visited returns 0 — "never opened" is not "unread", and a
/// badge that counted every session's whole history on first launch would be
/// noise on the one day it should be quiet.
public func unseenCount(mark: Watermark?, proseCount: Int?, activityCount: Int?, turns: Int?)
  -> Int
{
  guard let mark else { return 0 }
  if let proseCount {
    // `mark.prose` absent = a mark written before prose counting. Reading it as
    // "caught up" costs one missed badge on a session already visited; reading
    // it as 0 would badge every such session with its whole history.
    return max(0, proseCount - (mark.prose ?? proseCount))
  }
  if let activityCount { return max(0, activityCount - mark.activity) }
  return max(0, (turns ?? 0) - mark.turns)
}

/// The pre-prose spelling, kept so a caller with only the two older numbers
/// still reads the same ladder.
public func unseenCount(mark: Watermark?, activityCount: Int?, turns: Int?) -> Int {
  unseenCount(mark: mark, proseCount: nil, activityCount: activityCount, turns: turns)
}

/// The same arithmetic straight off a rollup record.
public func unseenCount(mark: Watermark?, info: SessionInfo) -> Int {
  unseenCount(
    mark: mark, proseCount: info.proseCount, activityCount: info.activityCount,
    turns: info.numTurns)
}
