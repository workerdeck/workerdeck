import Foundation

/// Which rows are open, and what a press on a line does.
///
/// The web client keeps this in component-local `useState` and gets away with
/// it: an expanded row is mounted, and the browser measures what it draws. This
/// renderer refuses to do that — every frame comes from `TerminalHeightBook`,
/// so **a height the book does not know about is a frame the layout gets
/// wrong**, and the row is clipped or overlaps its neighbour.
///
/// So expansion lives beside the rows and is fed into the planner. That
/// deliberately relaxes `TerminalPlan.swift`'s first invariant ("only the
/// collapsed state is ever planned") — the relaxation is the whole feature, and
/// it is why the budgets in ``ResultPreview/expandedChars`` exist rather than
/// letting an expanded row render a hundred thousand characters into a single
/// virtual row.
///
/// Keys are namespaced by what they open, and are the block/call ids the fold
/// already produced, so they survive a refold:
///
/// * `run:<first call id>` / `task:<call id>` — a folded block's own key.
/// * `call:<id>` — one tool call's result.
/// * `full:<id>` — that result's character budget lifted.
public struct TerminalExpansion: Equatable, Sendable {
  /// Blocks and calls that are open.
  public var open: Set<String>
  /// Results whose ``ResultPreview/expandedChars`` budget has been lifted.
  public var full: Set<String>

  public init(open: Set<String> = [], full: Set<String> = []) {
    self.open = open
    self.full = full
  }

  public var isEmpty: Bool { open.isEmpty && full.isEmpty }

  public static func openKey(callId: String) -> String { "call:\(callId)" }
  public static func fullKey(callId: String) -> String { "full:\(callId)" }

  public func isOpen(_ key: String) -> Bool { open.contains(key) }
  public func isFull(_ key: String) -> Bool { full.contains(key) }

  /// Apply a press. Returns `true` when it *opened* something — the caller uses
  /// that to decide whether the reader needs bringing back to the row's first
  /// line, which is a one-directional courtesy: a row already in view never
  /// moves, and closing one never scrolls.
  @discardableResult
  public mutating func apply(_ press: TermPress) -> Bool {
    switch press {
    case .toggle(let key):
      if open.contains(key) {
        open.remove(key)
        // Closing forgets that the budget was lifted: re-opening a
        // hundred-thousand-character result straight into its unclipped form
        // would undo the layout guard for a reader who has since scrolled a
        // thousand rows away and forgotten they ever asked.
        if key.hasPrefix("call:") { full.remove("full:" + key.dropFirst("call:".count)) }
        return false
      }
      open.insert(key)
      return true
    case .expandFull(let key):
      return full.insert(key).inserted
    }
  }

  /// Everything a row list could open, all at once.
  ///
  /// Nobody presses this into being — it is the **audit's** input. The overflow
  /// gate can only check lines it was given, and until expansion existed every
  /// line it was given was a collapsed one; a summary that wraps correctly says
  /// nothing about the fifty result lines hiding behind it. Planning is pure, so
  /// auditing the fully-open transcript costs a calculation and changes nothing
  /// on screen.
  public static func everything(in rows: TerminalRows) -> TerminalExpansion {
    var expansion = TerminalExpansion()
    for row in rows.rows {
      for key in expansionKeys(of: row) {
        if key.hasPrefix("full:") { expansion.full.insert(key) } else { expansion.open.insert(key) }
      }
    }
    return expansion
  }

  /// The part of this expansion a single row can read.
  ///
  /// Used as the plan cache's second key: an epoch-wide invalidation would
  /// re-plan every row in the transcript on every tap, which at
  /// `terminalStress`'s sixteen thousand rows is a rotation's worth of work for
  /// one finger. Rows that hold none of the open keys keep their cached height.
  public func subset(for row: TranscriptRow) -> TerminalExpansion {
    guard !isEmpty else { return TerminalExpansion() }
    let keys = expansionKeys(of: row)
    guard !keys.isEmpty else { return TerminalExpansion() }
    return TerminalExpansion(
      open: open.intersection(keys), full: full.intersection(keys))
  }
}

/// What a press on a line does. It rides the plan rather than being derived in
/// a view, for the same reason every string does: the planner is the one place
/// that knows what it drew, and a view that re-derived it would be a second
/// answer.
public enum TermPress: Equatable, Sendable {
  /// Open or close a block (a run, a task) or a tool call's result.
  case toggle(String)
  /// Lift an already-open result's character budget.
  case expandFull(String)
}

/// Every expansion key a row could hold, its nested children included.
///
/// O(children), which for all but a folded `Task` is O(1) — and it is only ever
/// reached when something is actually open (see ``TerminalExpansion/subset(for:)``).
public func expansionKeys(of row: TranscriptRow) -> Set<String> {
  switch row {
  case .recap: return []
  case .block(let block): return expansionKeys(of: block)
  }
}

public func expansionKeys(of block: TerminalBlock) -> Set<String> {
  switch block {
  case .item(let leaf):
    guard case .toolCall(let call) = leaf.item else { return [] }
    return callKeys(call)
  case .run(let leaf):
    // A run of one is drawn as the call itself (see `TerminalPlanner.planRun`),
    // so its own key opens nothing and must not be offered.
    guard leaf.run.count > 1 else { return leaf.run.first.map(callKeys) ?? [] }
    var keys: Set<String> = [leaf.key]
    for call in leaf.run { keys.formUnion(callKeys(call)) }
    return keys
  case .task(let leaf):
    var keys: Set<String> = [leaf.key]
    for child in leaf.children {
      switch child {
      case .item(let item):
        if case .toolCall(let call) = item.item { keys.formUnion(callKeys(call)) }
      case .run(let run):
        if run.run.count > 1 { keys.insert(run.key) }
        for call in run.run { keys.formUnion(callKeys(call)) }
      }
    }
    return keys
  }
}

private func callKeys(_ call: ToolCallItem) -> Set<String> {
  [TerminalExpansion.openKey(callId: call.id), TerminalExpansion.fullKey(callId: call.id)]
}
