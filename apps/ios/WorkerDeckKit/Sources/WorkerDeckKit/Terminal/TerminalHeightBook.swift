import Foundation

/// Every row's height and offset, for a given row list at a given cell —
/// the table a virtualizer indexes.
///
/// This is what makes the rest of the theme possible. A scrubber draws marks at
/// the pixel offsets of rows that were never mounted; a jump lands on a row a
/// thousand items above the fold; the scrollbar stops growing as rows measure,
/// because nothing is estimated and then corrected. All of that needs an
/// *answer* for a row that does not exist as a view, which only a computed
/// height can give.
///
/// A book is immutable and cheap to rebuild: heights come out of the plan cache,
/// so a streamed delta that changes the last row re-plans one row and re-sums an
/// array of doubles.
public struct TerminalHeightBook: Sendable {
  public let metrics: TerminalMetrics
  public let rows: TerminalRows

  /// Per row, its height **including the blank line above it**. The gap is part
  /// of the row rather than a separate item because a virtualizer measures one
  /// element per row — a standalone blank would be a row of its own, and every
  /// index would be off by however many blanks preceded it.
  private let heights: [CGFloat]
  /// Running offsets, `offsets[i]` = top of row `i`. One longer than `heights`,
  /// so the last entry is the total.
  private let offsets: [CGFloat]

  /// - Parameter frameParentId: the sub-agent frame these rows live in, when
  ///   they are a takeover's. It must reach the book because `nested` spends
  ///   cells, so suppressing it inside the frame changes the wrap — and the
  ///   lines drawn must be as tall as the height reserved, which means the book
  ///   and ``TerminalPlanner`` read the same value. A cache passed here must be
  ///   private to this frame: the plan cache keys on row and expansion alone.
  public init(
    rows: TerminalRows, metrics: TerminalMetrics, cache: TerminalPlanCache? = nil,
    expansion: TerminalExpansion = TerminalExpansion(), frameParentId: String? = nil
  ) {
    self.rows = rows
    self.metrics = metrics

    let lines = Self.lineCounts(
      rows: rows, metrics: metrics, cache: cache, expansion: expansion,
      frameParentId: frameParentId)

    var heights = [CGFloat](repeating: 0, count: rows.count)
    var offsets = [CGFloat](repeating: 0, count: rows.count + 1)
    for index in 0..<rows.count {
      let gap = rows.gapBefore(index) ? 1 : 0
      heights[index] = CGFloat(lines[index] + gap) * metrics.line
      offsets[index + 1] = offsets[index] + heights[index]
    }
    self.heights = heights
    self.offsets = offsets
  }

  /// Below this many cache misses, plan on the calling thread. Spinning up
  /// worker threads costs more than it saves for the case this is called in
  /// almost every time — a streamed delta, where exactly one row missed.
  private static let parallelPlanThreshold = 256

  /// Every row's line count: cache hits taken first, and the misses planned in
  /// parallel when there are enough of them to pay for it.
  ///
  /// The **cold** build is why this exists. Every other path through here is
  /// warm by construction — a delta re-plans one row — but the first build of a
  /// freshly attached session plans every row of its whole history, and that is
  /// the one moment the reader is staring at a blank screen waiting for it.
  /// Planning is pure and rows are independent, so it is embarrassingly
  /// parallel; the only reason it was serial is that nothing had measured it.
  private static func lineCounts(
    rows: TerminalRows, metrics: TerminalMetrics, cache: TerminalPlanCache?,
    expansion: TerminalExpansion, frameParentId: String? = nil
  ) -> [Int] {
    let count = rows.count
    guard count > 0 else { return [] }

    // The subset a row can read, computed once per row and outside any lock —
    // free while nothing is open, which is the overwhelmingly common case.
    let subsets: [TerminalExpansion] =
      expansion.isEmpty
      ? [TerminalExpansion](repeating: TerminalExpansion(), count: count)
      : (0..<count).map { expansion.subset(for: rows[$0]) }

    var lines = [Int](repeating: -1, count: count)
    // `let`, because every worker below reads it concurrently.
    let misses: [Int] = {
      guard let cache else { return Array(0..<count) }
      // Once, here, rather than per row: a cell change invalidates every entry,
      // and the check is what makes a hit below trustworthy.
      cache.beginEpoch(metrics)
      var missed: [Int] = []
      for index in 0..<count {
        if let hit = cache.cachedLineCount(rows[index], expansionSubset: subsets[index]) {
          lines[index] = hit
        } else {
          missed.append(index)
        }
      }
      return missed
    }()

    if misses.count >= parallelPlanThreshold {
      // Disjoint indices, one writer each, no shared mutable state — the plan
      // is a pure function of the row, the metrics and the subset. The cache is
      // deliberately *not* touched in here: it takes a lock, and a lock held
      // around the planning is the parallelism given straight back.
      lines.withUnsafeMutableBufferPointer { buffer in
        let sink = UncheckedSendable(buffer)
        DispatchQueue.concurrentPerform(iterations: misses.count) { slot in
          let index = misses[slot]
          sink.value[index] =
            TerminalPlanner.plan(
              rows[index], metrics: metrics, expansion: subsets[index],
              frameParentId: frameParentId
            ).count
        }
      }
    } else {
      for index in misses {
        lines[index] =
          TerminalPlanner.plan(
            rows[index], metrics: metrics, expansion: subsets[index],
            frameParentId: frameParentId
          ).count
      }
    }

    if let cache {
      for index in misses {
        cache.store(rows[index], expansionSubset: subsets[index], lines: lines[index])
      }
    }
    return lines
  }

  public var count: Int { heights.count }
  public var totalHeight: CGFloat { offsets.last ?? 0 }

  public func height(at index: Int) -> CGFloat {
    guard index >= 0, index < heights.count else { return 0 }
    return heights[index]
  }

  public func offset(at index: Int) -> CGFloat {
    guard index >= 0 else { return 0 }
    return index < offsets.count ? offsets[index] : totalHeight
  }

  /// Which row covers this content offset. Binary search — a scroll event must
  /// not walk the transcript.
  public func rowIndex(atOffset offset: CGFloat) -> Int {
    guard !heights.isEmpty else { return 0 }
    var low = 0
    var high = heights.count - 1
    while low < high {
      let mid = (low + high + 1) / 2
      if offsets[mid] <= offset { low = mid } else { high = mid - 1 }
    }
    return low
  }
}

/// A plan cache with the effect of the web client's `WeakMap` on transcript
/// items, built for a language where an array is a value and there is no
/// identity to hang one on.
///
/// Keyed by the row's key, holding the row it was computed from: a hit is an
/// equality check, which is orders of magnitude cheaper than wrapping the text
/// again, and a miss is exactly the row that changed. During a streamed turn
/// that is one row out of thousands.
///
/// The cache is *not* keyed on the metrics: a new cell means every line count is
/// wrong, so an epoch change clears it wholesale rather than growing a second
/// dimension nobody reads twice.
public final class TerminalPlanCache: @unchecked Sendable {
  private struct Entry {
    var row: TranscriptRow
    /// Only the part of the expansion *this row* can read. Keying the whole
    /// epoch on the expansion instead would re-plan the entire transcript on
    /// every tap — at `terminalStress`'s sixteen thousand rows, a rotation's
    /// worth of work for one finger.
    var expansion: TerminalExpansion
    var lines: Int
  }

  private var entries: [String: Entry] = [:]
  private var epoch: TerminalMetrics?
  private let lock = NSLock()

  public init() {}

  /// Enter the epoch this build measures in, clearing the cache if the cell
  /// moved. Called once per build rather than per row: every `cachedLineCount`
  /// after it is answering for *this* cell, which is what makes a hit sound.
  public func beginEpoch(_ metrics: TerminalMetrics) {
    lock.lock()
    defer { lock.unlock() }
    if epoch != metrics {
      entries.removeAll(keepingCapacity: true)
      epoch = metrics
    }
  }

  /// A hit, or `nil` for a row this cache cannot answer for. Never plans: the
  /// planning happens outside the lock, so a cold build can do it in parallel.
  public func cachedLineCount(_ row: TranscriptRow, expansionSubset: TerminalExpansion) -> Int? {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries[row.key], entry.row == row, entry.expansion == expansionSubset
    else { return nil }
    return entry.lines
  }

  public func store(_ row: TranscriptRow, expansionSubset: TerminalExpansion, lines: Int) {
    lock.lock()
    defer { lock.unlock() }
    entries[row.key] = Entry(row: row, expansion: expansionSubset, lines: lines)
  }

  /// The whole of the above in one call, for a caller measuring a single row.
  public func lineCount(
    _ row: TranscriptRow, metrics: TerminalMetrics,
    expansion: TerminalExpansion = TerminalExpansion()
  ) -> Int {
    beginEpoch(metrics)
    // Free in the overwhelmingly common case: nothing is open, so no row has to
    // be walked for its keys.
    let subset = expansion.isEmpty ? TerminalExpansion() : expansion.subset(for: row)
    if let hit = cachedLineCount(row, expansionSubset: subset) { return hit }
    let lines = TerminalPlanner.plan(row, metrics: metrics, expansion: subset).count
    store(row, expansionSubset: subset, lines: lines)
    return lines
  }

  /// Drop everything the current row list no longer holds. Called after a
  /// rebuild, so a long session's cache tracks the transcript rather than every
  /// row it has ever shown.
  public func evict(keeping rows: TerminalRows) {
    lock.lock()
    defer { lock.unlock() }
    let live = Set(rows.rows.map(\.key))
    entries = entries.filter { live.contains($0.key) }
  }
}


/// A box that carries a non-`Sendable` value across a `concurrentPerform`
/// closure. Sound only because the writes inside are to disjoint indices of a
/// buffer that outlives the call — `concurrentPerform` does not return until
/// every iteration has finished.
private struct UncheckedSendable<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}
