import Foundation

/// What a press opens, as a type rather than a string.
///
/// It was `String`, and that was a trap with a name: a block already carries a
/// `key` — its **row identity**, produced by the fold and mirrored in
/// `packages/ui`'s `blocks.ts`, used for diffing and for the plan cache — and
/// those two namespaces coincide for only two of the five shapes a block can
/// take. A `.item` tool call's row key is `toolCall:<id>` while what opens it is
/// `call:<id>`; a run of one is *drawn as the call* (see
/// ``TerminalPlanner/planRun``), so its `run:<id>` opens nothing at all. The
/// obvious call — `expansion.isOpen(block.key)` — was therefore wrong more often
/// than it was right, and it cost a real bug: an expanded lone `Bash` banded
/// nothing on the rail.
///
/// Typed, that call no longer compiles. Row keys stay `String` (web parity is
/// untouched), and ``expansionKeys(of:)-4ubvz`` is the only producer of these.
public enum ExpansionKey: Hashable, Sendable {
  /// A folded run's summary line, by its first call's id — stable as the run
  /// grows, the same anchor the fold keys the block by.
  case run(String)
  /// A folded `Task` header, by the task call's id.
  case task(String)
  /// One tool call's result.
  case call(String)
  /// A sub-agent's brief — the spawning call's `prompt`, by the task's id.
  /// Clipped to ``TerminalPlanner/briefLines`` when closed, the whole
  /// instruction when open. One key serves both places the brief draws — the
  /// frame's first row and the inline task expansion — because they are the
  /// same row about the same task; on the web the twin state is component-local
  /// `useState` in `BriefRow`, which this renderer cannot afford (a height the
  /// book does not know is a frame the layout gets wrong).
  case brief(String)
}

extension ExpansionKey: CustomStringConvertible {
  /// The old wire spelling, kept for messages and for a deterministic sort —
  /// never for identity, which is the case itself.
  public var description: String {
    switch self {
    case .run(let id): return "run:\(id)"
    case .task(let id): return "task:\(id)"
    case .call(let id): return "call:\(id)"
    case .brief(let id): return "brief:\(id)"
    }
  }
}

/// Which rows are open, and what a press on a line does.
///
/// The web client keeps this in component-local `useState` and gets away with
/// it: an expanded row is mounted, and the browser measures what it draws. This
/// renderer refuses to do that — every frame comes from `TerminalHeightBook`,
/// so **a height the book does not know about is a frame the layout gets
/// wrong**, and the row is clipped or overlaps its neighbour.
///
/// **The divergence is decided and permanent**, and is written up on the other
/// side too (`packages/ui/src/components/terminal/height.ts`, first invariant):
/// closing it in either direction costs one client its central simplification.
/// It is also the *reason* the rail here can be expansion-aware — a band over
/// the region you opened, a failed member of an open run marking on its own
/// line — and the web rail cannot. Two clients, one rule, different amounts of
/// it visible.
///
/// So expansion lives beside the rows and is fed into the planner. That
/// deliberately relaxes `TerminalPlan.swift`'s first invariant ("only the
/// collapsed state is ever planned") — the relaxation is the whole feature, and
/// it is why the budgets in ``ResultPreview/expandedChars`` exist rather than
/// letting an expanded row render a hundred thousand characters into a single
/// virtual row.
///
/// ``full`` and ``pending`` are **call ids, not keys**, and that is the shape of
/// the thing rather than a shortcut: there is no such state as a fully-expanded
/// run. It also deletes the prefix surgery that used to turn one key into
/// another — a `String(key.dropFirst("full:".count))` in two files, which is
/// exactly the sort of thing a type is for.
///
/// ``pending`` is the third state, and it exists because a truncated result's
/// press cannot be answered synchronously: the replay delivered a head, so "show
/// everything" is a network round trip. Planning from `total_chars` was the
/// alternative and is refused — it invents a line count for text nobody has
/// seen and then corrects it by thousands of points mid-scroll, which is the
/// estimate-and-correct model this renderer was built not to be. So the press
/// enters `pending`, the planner draws a line saying what is in flight, and the
/// fetched text arrives as a **mutation of the item** — one row misses the plan
/// cache, one row re-plans, and the planner is never asked about text it does
/// not have.
public struct TerminalExpansion: Equatable, Sendable {
  /// Blocks and calls that are open.
  public var open: Set<ExpansionKey>
  /// Calls whose ``ResultPreview/expandedChars`` budget has been lifted.
  public var full: Set<String>
  /// Calls whose result is a head, with the rest **in flight**.
  ///
  /// Disjoint from ``full`` by construction: an id here is holding the reader's
  /// press until the text lands, and ``finishFetch(callId:)`` moves it across
  /// in one step. Lifting the budget first would show eight thousand characters
  /// of head and then replace them, which is a flash, not a state.
  public var pending: Set<String>

  public init(open: Set<ExpansionKey> = [], full: Set<String> = [], pending: Set<String> = []) {
    self.open = open
    self.full = full
    self.pending = pending
  }

  public var isEmpty: Bool { open.isEmpty && full.isEmpty && pending.isEmpty }

  public func isOpen(_ key: ExpansionKey) -> Bool { open.contains(key) }
  public func isFull(callId: String) -> Bool { full.contains(callId) }
  public func isFetching(callId: String) -> Bool { pending.contains(callId) }

  /// The reader pressed "fetch the rest". Returns `true` when this is a new
  /// request — the caller starts the fetch on that, so a second press on a row
  /// already waiting does not open a second connection.
  @discardableResult
  public mutating func beginFetch(callId: String) -> Bool {
    guard !full.contains(callId) else { return false }
    return pending.insert(callId).inserted
  }

  /// The text landed. The id crosses from ``pending`` to ``full`` in one step,
  /// which is what makes the row go from "fetching 641,003 chars" straight to
  /// the whole result with nothing in between.
  ///
  /// An id the reader closed in the meantime is **not** promoted: closing forgets
  /// the request, and re-opening should not reveal a result the reader has since
  /// walked away from. The hydrated text is untouched either way — it lives on
  /// the item, not here.
  public mutating func finishFetch(callId: String) {
    guard pending.remove(callId) != nil else { return }
    full.insert(callId)
  }

  /// Apply a press. Returns `true` when it *opened* something — the caller uses
  /// that to decide whether the reader needs bringing back to the row's first
  /// line, which is a one-directional courtesy: a row already in view never
  /// moves, and closing one never scrolls.
  /// - Parameter subtree: every key inside the block this press landed on
  ///   (`expansionKeys(of:)`). Used only when a **container** closes, and then
  ///   it closes with it — see ``close(_:subtree:)``. Passing nothing keeps the
  ///   old behaviour, which is what the audit and the tests that predate this
  ///   want.
  @discardableResult
  public mutating func apply(_ press: TermPress, subtree: Set<ExpansionKey> = []) -> Bool {
    switch press {
    case .toggle(let key):
      if open.contains(key) {
        close(key, subtree: subtree)
        return false
      }
      open.insert(key)
      return true
    case .expandFull(let id):
      return full.insert(id).inserted
    case .openSubagent:
      // Not an expansion at all: the takeover is a navigation, handled by the
      // screen that has somewhere to push. Reaching here means a caller fed a
      // press to the wrong interpreter; opening nothing is the honest no-op.
      return false
    }
  }

  /// Close a row, and — for a container — everything inside it.
  ///
  /// **Collapsing a chain of tool calls collapses the chain.** Without this the
  /// keys of the rows it hides stay in ``open``, so re-opening the run hands
  /// back a screen the reader collapsed precisely to be rid of: six results,
  /// each in full. The web client gets this for free and by accident — its
  /// expansion is component-local `useState` and dies with the unmounted row —
  /// and this renderer holds expansion beside the rows on purpose (a height the
  /// book does not know is a frame the layout gets wrong), so it has to say the
  /// same thing out loud.
  ///
  /// It is the rule already written for a *call's* budget one level down,
  /// applied to containment: closing forgets. Re-opening is a fresh look at the
  /// row, not a restoration of a state the reader walked away from.
  ///
  /// A `.call` never takes a subtree with it, and that guard is load-bearing
  /// rather than defensive: the subtree handed in is the whole **block**, so a
  /// call closing "its" subtree would close every sibling result in the same
  /// run — one press collapsing five rows nobody touched. A `.brief` is a leaf
  /// for the same reason: inline, its subtree is the whole task block.
  private mutating func close(_ key: ExpansionKey, subtree: Set<ExpansionKey>) {
    var closing: Set<ExpansionKey> = [key]
    switch key {
    case .call, .brief: break
    case .run, .task: closing.formUnion(subtree)
    }
    open.subtract(closing)
    // Closing forgets that the budget was lifted: re-opening a
    // hundred-thousand-character result straight into its unclipped form would
    // undo the layout guard for a reader who has since scrolled a thousand rows
    // away and forgotten they ever asked. And it forgets a fetch in flight — the
    // bytes may still land, and are hydrated onto the item and kept, but this
    // reader is no longer waiting for them.
    for closed in closing {
      guard case .call(let id) = closed else { continue }
      full.remove(id)
      pending.remove(id)
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
      if case .brief(let id, _) = row {
        expansion.open.insert(.brief(id))
        continue
      }
      guard case .block(let block) = row else { continue }
      expansion.open.formUnion(expansionKeys(of: block))
      for drawn in blockCalls(in: block) where drawn.drawsResult {
        // A truncated result has no full state to plan — the text is a head — so
        // it lands in `pending`, which is the state a reader who pressed it
        // really sees. Auditing a `full` state whose text was never delivered
        // would be auditing a screen nobody can reach.
        if drawn.call.result?.truncated == true {
          expansion.pending.insert(drawn.call.id)
        } else {
          expansion.full.insert(drawn.call.id)
        }
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
    // The frame's brief row can read exactly one key. Through the subset like
    // every other, so toggling it re-plans that row and no other.
    if case .brief(let id, _) = row {
      return TerminalExpansion(open: open.intersection([.brief(id)]))
    }
    guard case .block(let block) = row else { return TerminalExpansion() }
    let calls = blockCalls(in: block)
    let ids = Set(calls.lazy.filter(\.drawsResult).map(\.call.id))
    let keys = expansionKeys(of: block, calls: calls)
    guard !keys.isEmpty || !ids.isEmpty else { return TerminalExpansion() }
    return TerminalExpansion(
      open: open.intersection(keys), full: full.intersection(ids),
      pending: pending.intersection(ids))
  }
}

/// What a press on a line does. It rides the plan rather than being derived in
/// a view, for the same reason every string does: the planner is the one place
/// that knows what it drew, and a view that re-derived it would be a second
/// answer.
public enum TermPress: Equatable, Sendable {
  /// Open or close a block (a run, a task) or a tool call's result.
  case toggle(ExpansionKey)
  /// Lift an already-open result's character budget, by the call's id.
  case expandFull(callId: String)
  /// Raise the sub-agent takeover: the screen becomes this `Task`'s own work.
  ///
  /// **Divergence from the web client, deliberately.** There the takeover is a
  /// hover *action* (`OpenSubagentAction`, the `⤢` in the row's overlay) and
  /// the row's press keeps meaning expand/collapse — a pointer can serve two
  /// intents on one 19px row. A thumb cannot: a second target inside a
  /// one-line row is a coin toss, so on the phone the `Task` row's one press is
  /// the deliberate move, and the inline expansion gives way to the surface
  /// that actually fits sixty rows of somebody else's working. The press rides
  /// the plan like every other (`planTask` attaches it); what *handles* it is
  /// the session screen, the only place that has a navigation stack to push.
  case openSubagent(taskId: String)
}

// MARK: - One walk of a block

/// A tool call a block draws, and how.
public struct BlockCall: Equatable, Sendable {
  public var call: ToolCallItem
  /// Its transcript index — never derivable by arithmetic, because a run folded
  /// across an absorbed gap has no `[index, index + count)` coverage.
  public var index: Int
  /// Is this call drawn **on a line of its own**, rather than stood for by a
  /// summary above it?
  ///
  /// This is the fold, expressed once. A lone call is its own row. A run of one
  /// is drawn as the call. A run of many draws a summary line collapsed — whose
  /// outcome, and so whose colour, is its **last** call — and every member on
  /// its own line when open. A `Task` header is always drawn (coloured by its
  /// own result, never a child's) and its children only once it is open.
  ///
  /// It is what ``redItemIndices(rows:expansion:)`` filters on, which is the
  /// whole of *"if it is red in the transcript, it is red on the rail"*.
  public var ownLine: Bool
  /// Is this call planned through ``TerminalPlanner/planToolCall`` — and so does
  /// it have a result, and keys that open one?
  ///
  /// False for exactly one thing: a `Task`'s **own** header call. `planTask`
  /// draws its summary and its children and never its own result, so a
  /// `.call(taskId)` key opens nothing — which is the run-of-one trap in a
  /// second dialect, and the reason it is stated here rather than left to each
  /// caller to remember. It is *not* the same question as ``ownLine``: the
  /// header is always drawn (it is what `taskFailed` reddens), it simply has no
  /// result behind it.
  public var drawsResult: Bool
}

/// Every tool call a block holds, in draw order, walked **once**.
///
/// This walk was written four times — here, in `expansionKeys`, in what used to
/// be `truncatedCallIds`, and in `redItemIndices` — with the same nested
/// item/run/task switch and the same task-children-as-leaves inner switch in
/// each. Four copies is four places to find a new block shape, and the one rule
/// the rail advertises (*"if it is red in the transcript, it is red on the
/// rail"*) is precisely a claim that two of them agree.
///
/// `TerminalPlanner` still walks a block itself, and deliberately: it is laying
/// out blanks, nesting and washes, which no visitor over calls can express.
/// ``BlockCall/ownLine`` is the one thing the two must agree about, and it is
/// stated here.
public func blockCalls(
  in block: TerminalBlock, expansion: TerminalExpansion = TerminalExpansion()
) -> [BlockCall] {
  var out: [BlockCall] = []

  func walk(_ leaf: TerminalLeafBlock, containerDrawn: Bool) {
    switch leaf {
    case .item(let item):
      guard case .toolCall(let call) = item.item else { return }
      out.append(
        BlockCall(call: call, index: item.index, ownLine: containerDrawn, drawsResult: true))
    case .run(let run):
      // A run of one is drawn as the call itself, so its member is on a line of
      // its own with no key to open. Otherwise: open, every member draws;
      // collapsed, only the summary does, and the summary *is* the run's last
      // call — `runFailed` colours it by exactly that.
      let open = run.expansionKey.map(expansion.isOpen) ?? true
      let last = run.run.count - 1
      for (ordinal, call) in run.run.enumerated() {
        let drawn = open || ordinal == last
        out.append(
          BlockCall(
            call: call, index: run.indices[ordinal], ownLine: drawn && containerDrawn,
            drawsResult: true))
      }
    }
  }

  switch block {
  case .item(let item):
    guard case .toolCall(let call) = item.item else { return [] }
    out.append(BlockCall(call: call, index: item.index, ownLine: true, drawsResult: true))
  case .run(let run):
    walk(.run(run), containerDrawn: true)
  case .task(let task):
    // The task's own outcome, collapsed or not: it is the header line, and it is
    // always drawn.
    out.append(
      BlockCall(call: task.task, index: task.index, ownLine: true, drawsResult: false))
    // A child is only on screen — and so only ever on a line of its own — once
    // the task is open.
    let open = expansion.isOpen(task.expansionKey)
    for child in task.children { walk(child, containerDrawn: open) }
  }
  return out
}

/// Every expansion key a block could open, its nested children included.
///
/// O(children), which for all but a folded `Task` is O(1) — and it is only ever
/// reached when something is actually open (see ``TerminalExpansion/subset(for:)``).
public func expansionKeys(of row: TranscriptRow) -> Set<ExpansionKey> {
  switch row {
  case .recap: return []
  case .brief(let id, _): return [.brief(id)]
  case .block(let block): return expansionKeys(of: block)
  }
}

public func expansionKeys(of block: TerminalBlock) -> Set<ExpansionKey> {
  expansionKeys(of: block, calls: blockCalls(in: block))
}

/// The same, for a caller that has already walked the block — `subset(for:)` is
/// on the plan cache's hot path and walked it twice.
func expansionKeys(of block: TerminalBlock, calls: [BlockCall]) -> Set<ExpansionKey> {
  var keys: Set<ExpansionKey> = []
  switch block {
  case .item: break
  case .run(let run):
    if let key = run.expansionKey { keys.insert(key) }
  case .task(let task):
    keys.insert(task.expansionKey)
    // The inline brief, when the engine gave one — same key as the frame's
    // first row, and its presence here is what scopes a brief toggle's re-plan
    // to this one row (`subset(for:)` reads these keys).
    if taskBrief(task.task) != nil { keys.insert(.brief(task.task.id)) }
    for child in task.children {
      if case .run(let run) = child, let key = run.expansionKey { keys.insert(key) }
    }
  }
  for drawn in calls where drawn.drawsResult { keys.insert(.call(drawn.call.id)) }
  return keys
}
