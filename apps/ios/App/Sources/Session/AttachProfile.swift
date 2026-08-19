import Foundation
import os

/// Stage timings for one attach, so "opening a session takes 2–3s" becomes a
/// breakdown instead of a feeling.
///
/// Deliberately consumer-side: everything here is measured from
/// `TranscriptViewModel`, so the kit is untouched and the numbers describe what
/// the *screen* waited for. That splits the wait into three buckets — connect,
/// the reduce fold, and everything else the replay spent (socket receive, JSON
/// decode, main-actor hops) — which is enough to say whether the answer is a
/// transcript cache, a background decode, or neither. Only if `other` dominates
/// does the split inside it need instrumenting too.
struct AttachProfile {
  let startedAt: Double
  var openedAt: Double?
  var attachedAt: Double?
  var target = 0
  var events = 0
  /// Wall time spent inside `applyEvent`, summed.
  var reduceSeconds = 0.0
  /// When the last replayed event was applied, and the seq it took the
  /// transcript to. The gap between this and `landedAt` is the hold *waiting*
  /// rather than the replay *arriving* — the one distinction the first
  /// on-device reading could not make, and the difference between "the phone is
  /// slow" and "the phone is asleep".
  var lastEventAt: Double?
  var seq = 0
  var landedAt: Double?

  init(now: Double = ProcessInfo.processInfo.systemUptime) { startedAt = now }

  static let log = Logger(subsystem: "bi.atomic.workerdeck", category: "attach")

  /// One line per attach, on the event that ends the hold.
  func report(reason: String) -> String {
    let end = landedAt ?? ProcessInfo.processInfo.systemUptime
    let ms = { (t: Double?) -> String in
      guard let t else { return "—" }
      return String(format: "%.0fms", (t - startedAt) * 1000)
    }
    let total = (end - startedAt) * 1000
    let reduce = reduceSeconds * 1000
    let arrivalEnd = lastEventAt ?? attachedAt ?? startedAt
    let replaySpan = (arrivalEnd - (attachedAt ?? startedAt)) * 1000
    let other = max(0, replaySpan - reduce)
    let waiting = (end - arrivalEnd) * 1000
    return String(
      format:
        "attach %@ · total %.0fms · open %@ · attached %@ · replay %.0fms "
        + "(reduce %.0fms, other %.0fms) · then waiting %.0fms · %d events, seq %d of %d",
      reason, total, ms(openedAt), ms(attachedAt), replaySpan, reduce, other, waiting, events,
      seq, target)
  }
}
