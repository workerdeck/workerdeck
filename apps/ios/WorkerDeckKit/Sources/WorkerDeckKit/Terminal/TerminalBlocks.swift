import Foundation

/// The terminal transcript's block model — a port of
/// `packages/ui/src/components/terminal/blocks.ts`.
///
/// Two folds, and each is the CLI's own compression:
///
/// * **A run of consecutive tool calls is one row.** The calls are almost never
///   what you came back to read, and six of them bury the sentence that is.
/// * **A `Task` and everything its subagent produced is one row.** A subagent is
///   sixty rows of somebody else's working; the report is the model's next
///   sentence.
///
/// The load-bearing difference between them: a run is built from **adjacency**,
/// a task from **membership** (`parentToolUseId`), because parallel Tasks
/// interleave in the stream. That is what broke the old row-model contract,
/// where a row covered a contiguous `[index, index + len)` — read
/// ``TerminalRows/rowIndex(forItem:)`` before touching anything positional.

// MARK: - Blocks

public struct TerminalItemBlock: Equatable, Sendable {
  public var key: String
  public var item: TranscriptItem
  /// The block's *address*: the transcript index of its first member.
  public var index: Int
}

public struct TerminalRunBlock: Equatable, Sendable {
  public var key: String
  public var run: [ToolCallItem]
  /// Every member's global transcript index, in stream order — `childIndices`'
  /// sibling, and needed for the same reason: a run folded across an absorbed
  /// gap has no `[index, index + count)` coverage, so a member's ordinal within
  /// the run (what the scrubber anchors a failure by) is unrecoverable from
  /// index arithmetic.
  public var indices: [Int]
  public var index: Int

  /// What a press on the summary line toggles — and **`nil` for a run of one**,
  /// which ``TerminalPlanner/planRun`` draws as the call itself, so there is no
  /// summary line and nothing for a `run:` key to open.
  ///
  /// An `Optional` rather than a documented exception, because the exception was
  /// invisible at every call site that mattered: `key` exists on every block, so
  /// `expansion.isOpen(block.key)` compiled, read correctly, and quietly did
  /// nothing for the commonest shape there is. Here the compiler asks.
  public var expansionKey: ExpansionKey? {
    run.count > 1 ? run.first.map { ExpansionKey.run($0.id) } : nil
  }
}

/// What can sit at top level or inside a task. A task never contains a task.
public enum TerminalLeafBlock: Equatable, Sendable {
  case item(TerminalItemBlock)
  case run(TerminalRunBlock)

  public var index: Int {
    switch self {
    case .item(let block): return block.index
    case .run(let block): return block.index
    }
  }

  public var key: String {
    switch self {
    case .item(let block): return block.key
    case .run(let block): return block.key
    }
  }

  /// The item this leaf is *spaced as* — what the blank-line rule reads.
  public var spacingItem: TranscriptItem? {
    switch self {
    case .item(let block): return block.item
    case .run(let block): return block.run.first.map(TranscriptItem.toolCall)
    }
  }
}

public struct TerminalTaskBlock: Equatable, Sendable {
  public var key: String
  public var task: ToolCallItem
  public var children: [TerminalLeafBlock]
  /// Every transcript index this row absorbed, so a jump to a nested item can
  /// resolve to the row that swallowed it.
  public var childIndices: [Int]
  public var index: Int

  /// What a press on the header line toggles. Always present — a `Task` is
  /// always drawn as a `Task`, whatever it holds.
  public var expansionKey: ExpansionKey { .task(task.id) }
}

public enum TerminalBlock: Equatable, Sendable {
  case item(TerminalItemBlock)
  case run(TerminalRunBlock)
  case task(TerminalTaskBlock)

  public var index: Int {
    switch self {
    case .item(let block): return block.index
    case .run(let block): return block.index
    case .task(let block): return block.index
    }
  }

  public var key: String {
    switch self {
    case .item(let block): return block.key
    case .run(let block): return block.key
    case .task(let block): return block.key
    }
  }

  /// The item a block is *spaced as* — what the blank-line rule reads.
  public var spacingItem: TranscriptItem? {
    switch self {
    case .item(let block): return block.item
    case .run(let block): return block.run.first.map(TranscriptItem.toolCall)
    case .task(let block): return .toolCall(block.task)
    }
  }
}

// MARK: - Parent accessor

/// The one accessor for a subagent parent. Never read the field directly: the
/// kinds that carry it spell it differently, and `nil` and "absent" must mean
/// the same thing here.
public func parentToolUseId(of item: TranscriptItem) -> String? {
  switch item {
  case .user(_, _, _, let parent): return parent
  case .assistantText(_, _, _, let parent): return parent
  case .thinking(_, _, let parent): return parent
  case .toolCall(let call): return call.parentToolUseId
  case .turnResult, .notice, .fileDelivered: return nil
  }
}

/// **The frame membership rule**: the items one sub-agent produced, and nothing
/// else — what the takeover renders instead of the whole conversation.
///
/// The port of `subagentItems` (`packages/ui/src/components/terminal/blocks.ts`),
/// and one function rather than a filter at each call site for the reason stated
/// there: this is a rule two renderers have to agree on, and a phone that framed
/// a sub-agent slightly differently would be a second answer to "what is this
/// agent doing".
///
/// It picks up the brief (a `user` item *with* a parent), the thinking, the
/// streamed text (stream ids are namespaced per sidechain, so a streaming item
/// carries the parent like any other), every tool call with its result, and the
/// final report. It excludes the spawning call itself — that is the frame, not a
/// row in it — and every other agent's work.
///
/// The slice is safe to hand straight to ``terminalBlocks(items:offset:)`` at
/// offset 0: nothing in it is top-level, so nothing absorbs, and consecutive
/// calls still fold into runs because the run fold keys on an *equal* parent
/// rather than on the absence of one.
public func subagentItems(
  _ items: [TranscriptItem],
  parentToolUseId parent: String
) -> [TranscriptItem] {
  items.filter { parentToolUseId(of: $0) == parent }
}

/// The spawning call behind a frame, when the transcript holds it — the one
/// item ``subagentItems(_:parentToolUseId:)`` deliberately excludes, looked up
/// by the takeover for the strip and for the brief row the frame opens with.
/// One function so the two callers cannot disagree about what "the task" is.
public func subagentTask(_ items: [TranscriptItem], id: String) -> ToolCallItem? {
  for item in items {
    if case .toolCall(let call) = item, call.id == id { return call }
  }
  return nil
}

// MARK: - The fold

/// Fold a slice of transcript items into rows.
///
/// - Parameters:
///   - offset: the transcript index the slice starts at. The virtualized shell
///     folds each side of the catch-up boundary separately, which is what stops
///     a run's count from spanning "what you already read".
///   - fold: `false` gives one block per item — the cards variant, which does no
///     folding at all.
public func terminalBlocks(
  _ items: [TranscriptItem], offset: Int = 0, fold: Bool = true
) -> [TerminalBlock] {
  guard fold else {
    return items.enumerated().map { position, item in
      .item(TerminalItemBlock(key: "\(item.kind.rawValue):\(item.id)", item: item, index: offset + position))
    }
  }

  // Pre-pass 1: which ids are top-level tool calls (i.e. could be a Task).
  var topLevelCalls: Set<String> = []
  for item in items {
    if case .toolCall(let call) = item, call.parentToolUseId == nil { topLevelCalls.insert(call.id) }
  }

  // Pre-pass 2: membership, by parent id and never by adjacency — parallel
  // subagents interleave, so the whole slice must be scanned before any block
  // is built.
  var childrenOf: [String: [(item: TranscriptItem, index: Int)]] = [:]
  for (position, item) in items.enumerated() {
    guard let parent = parentToolUseId(of: item), topLevelCalls.contains(parent) else { continue }
    childrenOf[parent, default: []].append((item, offset + position))
  }

  var out: [TerminalBlock] = []
  for (position, item) in items.enumerated() {
    let index = offset + position

    // Absorbed: it renders inside its task's row and must not also be its own.
    if let parent = parentToolUseId(of: item), childrenOf[parent] != nil { continue }

    if case .toolCall(let call) = item, let children = childrenOf[call.id] {
      // A task's children go through the *same* fold, so a subagent's own run
      // of tool calls collapses inside the task exactly as it would outside.
      var nested: [TerminalBlock] = []
      for child in children { pushLeaf(&nested, child.item, child.index) }
      out.append(
        .task(
          TerminalTaskBlock(
            key: "task:\(call.id)", task: call, children: nested.map(asLeaf),
            childIndices: children.map(\.index), index: index)))
      continue
    }

    pushLeaf(&out, item, index)
  }
  return out
}

/// The single fold implementation, used for the top level and for each task's
/// children alike.
///
/// A run block is keyed by its **first** call, so the key stays stable as the
/// run grows and the virtualizer keeps the measurement it already has. A `Task`
/// row sitting between two runs does not match here, which is why a task breaks
/// a run — right, since the task is not adjacent to what follows it on screen.
private func pushLeaf(_ out: inout [TerminalBlock], _ item: TranscriptItem, _ index: Int) {
  if case .toolCall(let call) = item {
    if case .run(var previous) = out.last, let first = previous.run.first,
      foldsTogether(first, call)
    {
      previous.run.append(call)
      previous.indices.append(index)
      out[out.count - 1] = .run(previous)
      return
    }
    out.append(
      TerminalBlock.run(
        TerminalRunBlock(key: "run:\(call.id)", run: [call], indices: [index], index: index)))
    return
  }
  out.append(
    .item(TerminalItemBlock(key: "\(item.kind.rawValue):\(item.id)", item: item, index: index)))
}

/// A task's children can only ever be leaves: absorption is one level deep, so
/// `pushLeaf` never produces a task here. A grandchild — whose parent is itself
/// a subagent's call — is deliberately *not* absorbed and renders at top level,
/// stepped in. An unmapped item must be visible, never gone.
private func asLeaf(_ block: TerminalBlock) -> TerminalLeafBlock {
  switch block {
  case .item(let leaf): return .item(leaf)
  case .run(let leaf): return .run(leaf)
  case .task(let leaf):
    return .item(
      TerminalItemBlock(key: leaf.key, item: .toolCall(leaf.task), index: leaf.index))
  }
}

/// A task's absorbed children, flat, in stream order.
public func taskChildItems(_ block: TerminalTaskBlock) -> [TranscriptItem] {
  block.children.flatMap { leaf -> [TranscriptItem] in
    switch leaf {
    case .item(let child): return [child.item]
    case .run(let child): return child.run.map(TranscriptItem.toolCall)
    }
  }
}

// MARK: - Blank lines

/// The theme's only spacing rule: one blank line between blocks, except between
/// two tool calls — a collapsed task or run sits flush with the tool rows of the
/// same turn.
public func needsBlank(_ previous: TranscriptItem, _ next: TranscriptItem) -> Bool {
  !(previous.kind == .toolCall && next.kind == .toolCall)
}

public func blockNeedsBlank(_ previous: TerminalBlock, _ next: TerminalBlock) -> Bool {
  guard let before = previous.spacingItem, let after = next.spacingItem else { return true }
  return needsBlank(before, after)
}

/// The same rule one frame in, between two of a `Task`'s absorbed children.
public func leafNeedsBlank(_ previous: TerminalLeafBlock, _ next: TerminalLeafBlock) -> Bool {
  guard let before = previous.spacingItem, let after = next.spacingItem else { return true }
  return needsBlank(before, after)
}
