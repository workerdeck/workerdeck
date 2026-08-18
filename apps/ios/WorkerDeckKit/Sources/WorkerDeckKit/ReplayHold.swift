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

/// Backstop for the replay hold: if the target seq has not landed after this
/// long, reveal whatever has arrived.
///
/// On a healthy attach the target is always reached, so this never fires. It
/// exists because a blank screen forever is a far worse failure than a visible
/// stream. It runs from the attach — a per-event re-arm would be a quiet-window
/// heuristic in a new costume, which is exactly what this design refuses.
public let replayHoldMaxSeconds: TimeInterval = 1.5

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
