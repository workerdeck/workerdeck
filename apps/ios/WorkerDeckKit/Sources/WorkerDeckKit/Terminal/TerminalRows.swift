import Foundation

/// The rows the transcript actually draws, and the arithmetic every jump goes
/// through — a port of `packages/ui/src/components/agent/transcript-rows.ts`.
///
/// A row is **not** a range of transcript indices. A `Task` row absorbs children
/// that interleave arbitrarily with everything else, and a run can fold across
/// an absorbed gap, so a row covers a *membership*. Anything positional —
/// a scrubber mark, the catch-up jump, a bookmark, "reveal this sub-agent" —
/// must resolve through ``rowIndex(forItem:)`` and never by arithmetic.

/// One drawn row: a folded block, or the catch-up seam spliced between them.
public enum TranscriptRow: Equatable, Sendable {
  case block(TerminalBlock)
  case recap(label: String)

  public var key: String {
    switch self {
    case .block(let block): return block.key
    case .recap: return "recap"
    }
  }

  /// The item a row is *spaced as*. The recap row has none, so it always gets a
  /// blank line on either side.
  public var spacingItem: TranscriptItem? {
    switch self {
    case .block(let block): return block.spacingItem
    case .recap: return nil
    }
  }
}

/// A built row list plus the two lookup tables that make it navigable.
///
/// Built once per items change and held by the view model, rather than the
/// web client's `WeakMap` cache — a Swift array is a value, so there is no
/// identity to hang a cache on, and computing both tables is one pass.
public struct TerminalRows: Equatable, Sendable {
  public var rows: [TranscriptRow]

  /// Transcript index → the row that absorbed it. No ordering argument can find
  /// these: parallel subagents interleave.
  private var absorbed: [Int: Int]
  /// Per row, the transcript index it sorts at. A recap row borrows its
  /// successor's start so the search stays monotonic, but can never be an
  /// answer.
  private var starts: [Int]
  private var answerable: [Bool]

  public init(rows: [TranscriptRow]) {
    self.rows = rows

    var absorbed: [Int: Int] = [:]
    for (rowIndex, row) in rows.enumerated() {
      guard case .block(.task(let task)) = row else { continue }
      for childIndex in task.childIndices { absorbed[childIndex] = rowIndex }
    }
    self.absorbed = absorbed

    var starts = [Int](repeating: 0, count: rows.count)
    var answerable = [Bool](repeating: false, count: rows.count)
    var successor = Int.max
    for rowIndex in stride(from: rows.count - 1, through: 0, by: -1) {
      if case .block(let block) = rows[rowIndex] {
        starts[rowIndex] = block.index
        answerable[rowIndex] = true
        successor = block.index
      } else {
        starts[rowIndex] = successor == Int.max ? Int.max : successor
      }
    }
    self.starts = starts
    self.answerable = answerable
  }

  /// Fold a transcript into rows, optionally splicing the catch-up seam.
  ///
  /// Each side of the boundary folds **separately**, which is what stops a run's
  /// count from spanning "what you already read" — the count under the seam
  /// describes only what is new.
  public static func build(
    items: [TranscriptItem], recapAt boundary: Int? = nil, recapLabel: String = "",
    fold: Bool = true
  ) -> TerminalRows {
    guard let boundary, boundary > 0, boundary < items.count else {
      return TerminalRows(rows: terminalBlocks(items, fold: fold).map(TranscriptRow.block))
    }
    let before = terminalBlocks(Array(items[..<boundary]), fold: fold).map(TranscriptRow.block)
    let after = terminalBlocks(Array(items[boundary...]), offset: boundary, fold: fold)
      .map(TranscriptRow.block)
    return TerminalRows(rows: before + [.recap(label: recapLabel)] + after)
  }

  public var count: Int { rows.count }
  public subscript(index: Int) -> TranscriptRow { rows[index] }

  /// Which row shows this transcript item?
  ///
  /// Absorbed indices are answered first, from the membership table. Everything
  /// else is the last answerable row whose index is at or before the target.
  public func rowIndex(forItem itemIndex: Int) -> Int {
    if let row = absorbed[itemIndex] { return row }
    var low = 0
    var high = rows.count - 1
    var best = 0
    while low <= high {
      let mid = (low + high) / 2
      if starts[mid] <= itemIndex {
        if answerable[mid] { best = mid }
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return best
  }

  /// Does a blank line go above this row? True at either edge of the recap seam,
  /// since a seam always breaks the run.
  public func gapBefore(_ index: Int) -> Bool {
    guard index > 0, index < rows.count else { return false }
    guard let before = rows[index - 1].spacingItem, let after = rows[index].spacingItem else {
      return true
    }
    return needsBlank(before, after)
  }
}

// MARK: - Prompt rows

extension TerminalRows {
  /// The row indices of the **human's own prompts**, ascending.
  ///
  /// What the sticky prompt is indexed by: "which turn am I reading" is
  /// answered by the last prompt at or above the viewport's top edge, and that
  /// is a binary search over this array rather than a walk of the transcript.
  ///
  /// A **subagent's brief is excluded**, and that is the rule worth stating: it
  /// really is a `user_message` on the wire (which is why it once rendered with
  /// the human's own `❯`), but it is the parent agent talking to its child. A
  /// turn is a thing a person started, so a sticky header naming a subagent's
  /// brief would answer a question nobody asked. `parentToolUseId` is the test.
  public var promptRows: [Int] {
    var found: [Int] = []
    for (index, row) in rows.enumerated() {
      guard case .block(.item(let block)) = row, case .user(_, _, _, let parent) = block.item,
        parent == nil
      else { continue }
      found.append(index)
    }
    return found
  }
}
