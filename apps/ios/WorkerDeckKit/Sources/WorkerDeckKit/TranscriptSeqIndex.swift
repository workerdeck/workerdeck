import Foundation

/// Where an event's `seq` landed in the transcript's item list.
///
/// Exists for exactly one caller: a push notification carries the `seq` of the
/// event it is about (`packages/protocol`: *"Seq of the event behind this
/// notification"*), and a tap should land the reader **on that row** rather than
/// at the tail. Nothing in `TranscriptState` can answer that — items are folded,
/// merged and mutated by later events, and only a handful embed a seq in their
/// id — so the answer has to be recorded as the fold happens.
///
/// Deliberately *beside* the reducer rather than inside it: `TranscriptState` is
/// a hand-mirror of the react reducer (`packages/react`), and a field only the
/// phone needs is a field the two copies would disagree about. The reducer stays
/// pure and unchanged; the caller notes the item count either side of each
/// `applyEvent` and this keeps the landmarks.
///
/// One landmark per event that *appended* — an event that only mutates an
/// existing item (a tool result settling onto its call, a streamed delta) adds
/// nothing, because the row it changes is already reachable through an earlier
/// landmark.
public struct TranscriptSeqIndex: Sendable, Equatable {
  /// "The event at `seq` first appended the item at `item`."
  public struct Mark: Sendable, Equatable {
    public var seq: Int
    public var item: Int

    public init(seq: Int, item: Int) {
      self.seq = seq
      self.item = item
    }
  }

  private var marks: [Mark] = []

  public init() {}

  public var isEmpty: Bool { marks.isEmpty }
  public var count: Int { marks.count }

  /// Record what one applied event did to the item list.
  ///
  /// - Parameters:
  ///   - seq: the event's seq.
  ///   - itemsBefore: `state.items.count` before `applyEvent`.
  ///   - itemsAfter: `state.items.count` after it.
  ///
  /// A **shrink** is a `/clear` (`conversation_reset` empties `items`), and it
  /// invalidates every index recorded so far — so the landmarks go with it. Not
  /// a special case worth guarding elsewhere: this is the one place that knows
  /// the counts, and a stale landmark would scroll a fresh conversation to a row
  /// that no longer exists.
  public mutating func note(seq: Int, itemsBefore: Int, itemsAfter: Int) {
    let firstNew: Int
    if itemsAfter < itemsBefore {
      marks.removeAll()
      // The reset itself can leave rows behind (it does not on `/clear` today,
      // but a compaction that replaced the history with a summary would), and
      // they start at zero like any other fresh list.
      guard itemsAfter > 0 else { return }
      firstNew = 0
    } else {
      guard itemsAfter > itemsBefore else { return }
      firstNew = itemsBefore
    }
    // Events replay in seq order, so this stays ascending in both fields — which
    // is what makes the lookup a binary search rather than a walk of a session's
    // entire history on every deep link. A seq that does not advance is a
    // duplicate the reducer would have refused anyway.
    if let last = marks.last, seq <= last.seq { return }
    marks.append(Mark(seq: seq, item: firstNew))
  }

  /// The item to land on for an event's `seq`: the first item appended **at or
  /// after** it.
  ///
  /// Not an exact match, on purpose. The event behind a notification does not
  /// always append an item of its own — `permission_requested` raises an
  /// approval and no row — so the honest answer is "the nearest row that had not
  /// been written yet when this happened".
  ///
  /// Two misses, and they mean opposite things:
  /// - `seq` **older** than anything held (the server's retention dropped it, or
  ///   a `/clear` did): returns the first landmark, i.e. the top of what there
  ///   is. As close as the transcript can get.
  /// - `seq` **newer** than anything held (the event has not arrived, or never
  ///   produced a row): returns `nil`. The caller should then leave the reader
  ///   where they are — the tail, which is where that event will appear anyway.
  public func item(forSeq seq: Int) -> Int? {
    guard let last = marks.last else { return nil }
    guard seq <= last.seq else { return nil }
    var low = 0
    var high = marks.count - 1
    while low < high {
      let mid = (low + high) / 2
      if marks[mid].seq >= seq { high = mid } else { low = mid + 1 }
    }
    return marks[low].item
  }
}
