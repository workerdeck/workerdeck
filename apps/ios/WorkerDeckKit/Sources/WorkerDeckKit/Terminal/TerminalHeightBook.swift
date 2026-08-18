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

  public init(
    rows: TerminalRows, metrics: TerminalMetrics, cache: TerminalPlanCache? = nil,
    expansion: TerminalExpansion = TerminalExpansion()
  ) {
    self.rows = rows
    self.metrics = metrics

    var heights = [CGFloat](repeating: 0, count: rows.count)
    var offsets = [CGFloat](repeating: 0, count: rows.count + 1)
    for index in 0..<rows.count {
      let lines =
        cache?.lineCount(rows[index], metrics: metrics, expansion: expansion)
        ?? TerminalPlanner.plan(rows[index], metrics: metrics, expansion: expansion).count
      let gap = rows.gapBefore(index) ? 1 : 0
      heights[index] = CGFloat(lines + gap) * metrics.line
      offsets[index + 1] = offsets[index] + heights[index]
    }
    self.heights = heights
    self.offsets = offsets
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

  public func lineCount(
    _ row: TranscriptRow, metrics: TerminalMetrics,
    expansion: TerminalExpansion = TerminalExpansion()
  ) -> Int {
    lock.lock()
    defer { lock.unlock() }
    if epoch != metrics {
      entries.removeAll(keepingCapacity: true)
      epoch = metrics
    }
    let key = row.key
    // Free in the overwhelmingly common case: nothing is open, so no row has to
    // be walked for its keys.
    let subset = expansion.isEmpty ? TerminalExpansion() : expansion.subset(for: row)
    if let entry = entries[key], entry.row == row, entry.expansion == subset { return entry.lines }
    let lines = TerminalPlanner.plan(row, metrics: metrics, expansion: subset).count
    entries[key] = Entry(row: row, expansion: subset, lines: lines)
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
