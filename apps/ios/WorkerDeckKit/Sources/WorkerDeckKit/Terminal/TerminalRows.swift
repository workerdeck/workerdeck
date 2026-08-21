import Foundation

/// The rows the transcript actually draws, and the arithmetic every jump goes
/// through — a port of `packages/ui/src/components/agent/transcript-rows.ts`.
///
/// A row is **not** a range of transcript indices. A `Task` row absorbs children
/// that interleave arbitrarily with everything else, and a run can fold across
/// an absorbed gap, so a row covers a *membership*. Anything positional —
/// a scrubber mark, the catch-up jump, a bookmark, "reveal this sub-agent" —
/// must resolve through ``rowIndex(forItem:)`` and never by arithmetic.

/// Where an item sits inside a row shared with other items: its 0-based ordinal
/// in stream order, out of `count` siblings. `0 <= ordinal < count`.
public struct RowPosition: Equatable, Sendable {
  public var ordinal: Int
  public var count: Int

  public init(ordinal: Int, count: Int) {
    self.ordinal = ordinal
    self.count = count
  }
}

/// One drawn row: a folded block, the catch-up seam spliced between them, or
/// the sub-agent brief a frame opens with.
public enum TranscriptRow: Equatable, Sendable {
  case block(TerminalBlock)
  case recap(label: String)
  /// **What this agent was asked** — the takeover frame's first row, spliced
  /// ahead of the fold exactly as the web splices `{ key: 'brief', text }`
  /// (`transcript-rows.ts`). Synthetic of necessity: the instruction is the
  /// spawning call's `prompt` and the engine never emits it as an item, so no
  /// fold can produce this row. It carries `taskBrief`'s output rather than the
  /// call, so a status mutation on the task (running → settled) does not
  /// re-key a row whose every drawn line reads only the prompt.
  case brief(id: String, text: String)

  public var key: String {
    switch self {
    case .block(let block): return block.key
    case .recap: return "recap"
    case .brief(let id, _): return "brief:\(id)"
    }
  }

  /// The item a row is *spaced as*. The recap row has none, so it always gets a
  /// blank line on either side — and the brief row likewise: the instruction is
  /// not part of the work's own spacing run.
  public var spacingItem: TranscriptItem? {
    switch self {
    case .block(let block): return block.spacingItem
    case .recap, .brief: return nil
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
  /// Transcript index → where the item sits inside a row it SHARES with other
  /// items. Built in the same pass as `absorbed`, for the same reason: nothing
  /// positional can be recovered by arithmetic here.
  private var positions: [Int: RowPosition]
  /// Per row, the transcript index it sorts at. A recap row borrows its
  /// successor's start so the search stays monotonic, but can never be an
  /// answer.
  private var starts: [Int]
  private var answerable: [Bool]

  public init(rows: [TranscriptRow]) {
    self.rows = rows

    var absorbed: [Int: Int] = [:]
    var positions: [Int: RowPosition] = [:]
    for (rowIndex, row) in rows.enumerated() {
      guard case .block(let block) = row else { continue }
      switch block {
      case .task(let task):
        for (ordinal, childIndex) in task.childIndices.enumerated() {
          absorbed[childIndex] = rowIndex
          positions[childIndex] = RowPosition(ordinal: ordinal, count: task.childIndices.count)
        }
      // A run of ONE gets no position, and that carve-out is load-bearing: the
      // fold makes every top-level tool call a run block, usually of length 1,
      // so without it every ordinary failed call's mark would shrink from its
      // row's extent to a tick and the rail would stop reading as a map.
      case .run(let run) where run.run.count > 1:
        for (ordinal, memberIndex) in run.indices.enumerated() {
          positions[memberIndex] = RowPosition(ordinal: ordinal, count: run.run.count)
        }
      case .item, .run:
        break
      }
    }
    self.absorbed = absorbed
    self.positions = positions

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
  /// - Parameter frameTask: the spawning call, when these items are a
  ///   sub-agent's frame — the takeover. Its brief leads the rows, because a
  ///   frame without its instruction is half a transcript. **No `prompt`, no
  ///   row**: codex's spawn message is encrypted on the wire, and an empty
  ///   brief row would assert we know what we don't. (A frame never carries a
  ///   recap — `TerminalTranscriptView` constructs its frame model
  ///   boundary-free — so the brief leads whichever path builds the rows.)
  public static func build(
    items: [TranscriptItem], recapAt boundary: Int? = nil, recapLabel: String = "",
    fold: Bool = true, frameTask: ToolCallItem? = nil
  ) -> TerminalRows {
    // Only when the agent's own stream carries no brief. A **foreground** Task
    // forwards one as a real nested user item, which is already the frame's
    // first row; a **background** agent forwards nothing (measured: eight of
    // them, not one `user` item with a parent), and those are exactly the runs
    // a takeover is opened on. Splicing unconditionally would draw one
    // instruction twice — see `taskBrief`.
    let streamHasBrief = items.contains { if case .user = $0 { return true } else { return false } }
    let lead: [TranscriptRow] =
      streamHasBrief
      ? []
      : frameTask.flatMap { task in taskBrief(task).map { [.brief(id: task.id, text: $0)] } } ?? []
    guard let boundary, boundary > 0, boundary < items.count else {
      return TerminalRows(
        rows: lead + terminalBlocks(items, fold: fold).map(TranscriptRow.block))
    }
    let before = terminalBlocks(Array(items[..<boundary]), fold: fold).map(TranscriptRow.block)
    let after = terminalBlocks(Array(items[boundary...]), offset: boundary, fold: fold)
      .map(TranscriptRow.block)
    return TerminalRows(rows: lead + before + [.recap(label: recapLabel)] + after)
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

  /// Where an item sits inside a row that holds MORE than itself — a task
  /// block's absorbed child, or a member of a folded run of two or more. `nil`
  /// for everything else, including a row's own head item and a singleton run:
  /// there the row's extent IS the item's, and a mark spanning it is honest.
  ///
  /// The scrubber is the consumer: a mark for a shared-row item anchors at
  /// `ordinal / count` of the row's height instead of inheriting an extent that
  /// is mostly other items' work — expanded, one failed child of a hundred-call
  /// task painted a solid band down the whole rail.
  public func position(forItem itemIndex: Int) -> RowPosition? { positions[itemIndex] }

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
