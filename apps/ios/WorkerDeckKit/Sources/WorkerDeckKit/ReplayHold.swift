import Foundation

/// Opening a session without the flicker — a port of the `replaying` half of
/// `packages/react/src/hooks/use-session.ts`.
///
/// The problem is not scroll position. An attach replays a session's whole
/// history in bursts, and without a hold you watch hundreds of rows stream past
/// a correctly-pinned viewport while the scroll view repeatedly re-lays-out
/// underneath them. The fix is to not draw anything until the replay has
/// landed, and then reveal it already at the bottom.
///
/// What makes this sound rather than a guess is that the end of the replay is
/// **stated**, not detected.

/// The seq the initial attach replay ends on, or `nil` when there is nothing to
/// hold for.
///
/// This is an **exact signal, not a heuristic**: the `attached` frame is sent
/// before any replayed `event` frame and carries the runner's seq at attach time
/// (`session.lastSeq`), so the moment the frame arrives the client knows
/// precisely which seq the replay ends on. Every runner keeps its full event log
/// and always delivers the highest-seq event on a fresh replay, so
/// `TranscriptState.lastSeq >= target` means the replay has landed. No quiet
/// window or other arrival heuristic belongs here.
///
/// Only a **fresh** attach yields a target (`replayingFrom == 0`): a reconnect
/// replays into a transcript the reader is already looking at, and blanking it
/// mid-turn would be a worse bug than the flicker the hold exists to fix. A
/// brand-new session (`lastSeq == 0`) has nothing to replay and never holds.
public func initialReplayTarget(_ frame: AttachedFrame) -> Int? {
  guard frame.replayingFrom == 0, frame.session.lastSeq > 0 else { return nil }
  return frame.session.lastSeq
}

/// How long the hold tolerates **no progress** before giving up and revealing
/// whatever has arrived.
///
/// This was `replayHoldMaxSeconds`, a flat 1.5s from the attach — the web
/// client's `REPLAY_HOLD_MAX_MS`, and the web client is usually talking to
/// localhost. A phone on a tailnet replaying thousands of events does not finish
/// in 1.5s, so the flat deadline fired on exactly the sessions the hold exists
/// for, producing exactly the symptom it exists to prevent.
public let replayHoldStallSeconds: TimeInterval = 1.5

/// The absolute ceiling on the hold, however well the replay is progressing.
///
/// A blank screen forever is a far worse failure than a visible stream, so the
/// extending deadline still needs a floor under it: a pathological replay that
/// dribbles one event a second forever must not hold the transcript blank
/// forever.
public let replayHoldCeilingSeconds: TimeInterval = 20

/// The state of one initial-attach hold.
///
/// **Why extending the deadline on progress is not the quiet-window heuristic
/// this design refuses.** That refusal is about detecting the *end* of the
/// replay by arrival timing — reveal once N ms have passed quietly — which is
/// wrong because a burst with a gap in it reveals early and a fast replay
/// reveals late. Nothing here decides the end: the end is still the stated
/// `target`, and the hold still ends on the exact event that reaches it. This
/// decides only *when to give up*, which is a question about liveness, not about
/// completion, and for which arrival timing is the only available signal.
///
/// Progress is measured on `TranscriptState.lastSeq`, not on raw event arrival:
/// a reconnect storm delivers events that are not this replay, and a stalled
/// replay that is nonetheless receiving frames must still time out.
public struct ReplayHold: Sendable, Equatable {
  /// The stated seq the replay ends on.
  public let target: Int
  /// Highest seq applied so far.
  public private(set) var seq: Int
  /// Monotonic time the hold was armed.
  public let startedAt: TimeInterval
  /// Monotonic time `seq` last advanced (or `startedAt`).
  public private(set) var progressedAt: TimeInterval

  public init(target: Int, seq: Int = 0, now: TimeInterval) {
    self.target = target
    self.seq = seq
    self.startedAt = now
    self.progressedAt = now
  }

  /// The replay has landed: the stated end arrived.
  public var landed: Bool { seq >= target }

  /// Apply the transcript's current `lastSeq`. Returns `true` when it advanced,
  /// which is what moves the stall deadline.
  @discardableResult
  public mutating func advance(to lastSeq: Int, now: TimeInterval) -> Bool {
    guard lastSeq > seq else { return false }
    seq = lastSeq
    progressedAt = now
    return true
  }

  /// When the hold gives up if nothing more arrives — the earlier of the stall
  /// deadline and the absolute ceiling.
  public var deadline: TimeInterval {
    min(progressedAt + replayHoldStallSeconds, startedAt + replayHoldCeilingSeconds)
  }

  /// Give up now? (`>=` so a test can name the deadline exactly.)
  public func expired(now: TimeInterval) -> Bool { now >= deadline }
}
