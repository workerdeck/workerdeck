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
/// pure and unchanged; the caller hands it the item list either side of each
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
  ///   - before: `state.items` before `applyEvent`.
  ///   - after: `state.items` after it.
  ///
  /// Counts cannot tell a `/clear` from an ordinary turn — `conversation_reset` empties
  /// `items`, but `assistant_message` also drops the streamed placeholders it supersedes,
  /// so a normal turn shrinks the list too, and treating every shrink as a reset loses the
  /// landmarks of any session that has ever shown thinking. The lists themselves can tell:
  /// where their ids first diverge is where this event's rows begin, and every landmark at
  /// or past that point is aimed at a row that moved or went away.
  public mutating func note(seq: Int, before: [TranscriptItem], after: [TranscriptItem]) {
    // The item that was last before the fold is still at its old index, so nothing earlier
    // moved and an append is all this event did — the common case, and O(1).
    let tail = before.count - 1
    if tail < 0 || (after.count > tail && after[tail].id == before[tail].id) {
      guard after.count > before.count else { return }
      append(seq: seq, item: before.count)
      return
    }
    var firstChanged = 0
    while firstChanged < after.count, firstChanged < before.count,
      after[firstChanged].id == before[firstChanged].id
    {
      firstChanged += 1
    }
    marks.removeAll { $0.item >= firstChanged }
    // Removals only: the rows this event is about are gone, so it gets no landmark of its
    // own and a lookup rounds up to the next one — which is what `/clear` leaves behind.
    guard firstChanged < after.count else { return }
    append(seq: seq, item: firstChanged)
  }

  private mutating func append(seq: Int, item: Int) {
    // Events replay in seq order, so this stays ascending in both fields — which
    // is what makes the lookup a binary search rather than a walk of a session's
    // entire history on every deep link. A seq that does not advance is a
    // duplicate the reducer would have refused anyway.
    if let last = marks.last, seq <= last.seq { return }
    marks.append(Mark(seq: seq, item: item))
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

// What a deep link does with the row it looked up. `complete` is whether the attach's stated
// seq has been reached — not whether the replay hold has ended, which it also does on a stall.
// A row found while the transcript is still filling is landed on but must never be followed:
// it sits at the tail of what has arrived so far, and a pin taken there is dragged down by
// everything that lands after it.
public enum DeepLinkPlacement: Equatable, Sendable {
  case pending
  case unplaceable
  case item(Int, complete: Bool)
}

// Whether a `seq` carried by a notification still addresses the log the session is on.
// A dormant wake starts the log again from zero, so a push that sat on a lock screen across
// one names a row that no longer exists — and its number, being small again, resolves to a
// perfectly plausible wrong row rather than to nothing. Absent on either side means "same
// log": an older gateway never says otherwise, and a session that has never woken is still
// on its first one.
public func deepLinkSeqSurvives(pushEpoch: Int?, sessionEpoch: Int?) -> Bool {
  (pushEpoch ?? 0) == (sessionEpoch ?? 0)
}

public func deepLinkPlacement(item: Int?, lastSeq: Int, attachLastSeq: Int) -> DeepLinkPlacement {
  let complete = lastSeq >= attachLastSeq
  if let item { return .item(item, complete: complete) }
  return complete ? .unplaceable : .pending
}
