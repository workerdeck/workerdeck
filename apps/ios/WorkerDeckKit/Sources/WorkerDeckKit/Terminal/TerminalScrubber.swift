import Foundation

/// The overview ruler — a port of `packages/ui/src/components/terminal/scrubber.tsx`.
///
/// **This is what the height book was built for.** A mark's position is its
/// row's *pixel offset*, not its index, and almost every row a rail draws is
/// unmounted — so the rail is only drawable at all because
/// ``TerminalHeightBook`` answers for rows that do not exist as views.
///
/// The logic lives here rather than in a SwiftUI view for the reason the web
/// client exports `buildClusters` and `railScale` for its tests alone: **both
/// have shipped pure-logic bugs**. A live answer with no `turn_result` yet went
/// unmarked for the whole two minutes it was the only thing worth navigating
/// to, and a replayed history — which carries no turn rows at all — came back
/// with an empty response lane. Neither is visible in a screenshot.
///
/// Two rules that are bugs if dropped, both called out in the phase-2 plan:
/// ``railScale``'s denominator is `max(totalSize, viewportHeight)` and never
/// `totalSize` alone, and **a mark's item index is not its row index** — every
/// one of them goes through ``TerminalRows/rowIndex(forItem:)``.

// MARK: - Vocabulary

/// Which column of the rail a mark sits in.
///
/// The two lanes are **channels, not classes**: left is what went *in* — your
/// prompts, and the sub-agents you dispatched — and right is what came *out* —
/// each turn's answer, and everything that went wrong producing one. That is the
/// question a reader actually asks of a rail ("where did I say something",
/// "where did it go wrong"), and it puts every failure in one column instead of
/// scattering some down the middle. Full width is left for what is not a channel
/// at all: a waiting approval (the session asking *you*), a bookmark (the
/// reader's own annotation) and the catch-up seam (a boundary across both).
public enum ScrubberLane: String, Equatable, Sendable {
  case left = "l"
  case right = "r"
  case full = "f"
}

public enum ScrubberMarkKind: String, Equatable, Sendable, CaseIterable {
  case user, subagent, turn, turnFailed, toolFailed, error, approval, recap, bookmark

  public var lane: ScrubberLane {
    switch self {
    // Delegated work is input: a sub-agent runs because you asked for it, and
    // its stretch of the transcript is *your* dispatch rather than the session's
    // answer. It is also a folded `Task`'s one honest signal on the rail —
    // collapsed, sixty rows of somebody else's working are a single line.
    case .user, .subagent: return .left
    // Output, with the answers: a failed tool call is something the run
    // produced. It had been full-width on the argument that it is an alarm
    // rather than a step — but "alarm" is not a lane, and half the failures
    // sitting down the middle while `turnFailed` sat in the right lane meant no
    // single column answered "did anything go wrong".
    case .turn, .turnFailed, .toolFailed, .error: return .right
    case .approval, .recap, .bookmark: return .full
    }
  }

  /// Who wins the colour when marks merge.
  public var loudness: Int {
    switch self {
    case .approval: return 7
    case .error: return 6
    case .turnFailed: return 5
    // Under `error`, which is the rank that actually does work: both are the
    // full lane, so a session error and a tool failure a pixel apart merge and
    // the error must keep the cluster. A failed tool call the model recovered
    // from is routine in a way a session error is not — hence quieter here, and
    // drawn at 55%. The one thing it outranks is `bookmark`, which loses its
    // magenta to a failure it sits beside.
    case .toolFailed: return 4
    case .user: return 3
    case .turn: return 2
    case .bookmark: return 1
    // Lane `left`, so this is only ever weighed against `user`, and a prompt
    // wins: the prompt is the step you navigate by and the sub-agent band is the
    // annotation on it. (It ties with `bookmark`, which it can never meet.)
    case .subagent: return 1
    case .recap: return 0
    }
  }

  public var name: String {
    switch self {
    case .user: return "you"
    case .subagent: return "sub-agent"
    case .turn: return "response · turn end"
    case .turnFailed: return "turn failed"
    case .toolFailed: return "tool failed"
    case .error: return "error"
    case .approval: return "pending approval"
    case .recap: return "catch-up boundary"
    case .bookmark: return "bookmark"
    }
  }
}

public struct ScrubberMark: Equatable, Sendable {
  public var kind: ScrubberMarkKind
  /// The jump anchor — for a turn mark, the paired response. `-1` for the recap
  /// seam and the pinned approval, which have no item.
  public var itemIndex: Int
  public var rowIndex: Int
  /// The `turn_result` behind a response mark; the peek shows its done-line.
  public var turnIndex: Int?

  public init(kind: ScrubberMarkKind, itemIndex: Int, rowIndex: Int, turnIndex: Int? = nil) {
    self.kind = kind
    self.itemIndex = itemIndex
    self.rowIndex = rowIndex
    self.turnIndex = turnIndex
  }
}

public struct ScrubberMember: Equatable, Sendable {
  public var mark: ScrubberMark
  public var y: CGFloat
}

/// Members keep their own y: a dense transcript chain-merges a lane into one
/// tall bar (six hundred prompts over a three-hundred-point rail *is* a solid
/// stripe, exactly as VS Code draws dense decorations), and the bar answers the
/// pointer by its **nearest member** — a press at the middle of the bar must not
/// act on whichever mark happened to found the cluster.
public struct ScrubberCluster: Equatable, Sendable {
  public var lane: ScrubberLane
  public var kind: ScrubberMarkKind
  public var y: CGFloat
  public var h: CGFloat
  public var marks: [ScrubberMember]

  /// The member closest to a rail-space y.
  public func nearestMember(to y: CGFloat) -> ScrubberMark? {
    var best: ScrubberMember?
    for member in marks where best == nil || abs(member.y - y) < abs(best!.y - y) {
      best = member
    }
    return best?.mark
  }
}

/// The catch-up seam's position on the rail, when one is spliced in.
public struct ScrubberRecap: Equatable, Sendable {
  public var rowIndex: Int
  public var label: String

  public init(rowIndex: Int, label: String) {
    self.rowIndex = rowIndex
    self.label = label
  }
}

/// Everything the rail is built from. `rows` and `book` are passed whole rather
/// than as closures — this is Swift and both are values — which also makes the
/// "an item index is not a row index" rule impossible to route around.
public struct ScrubberInput {
  public var items: [TranscriptItem]
  public var rows: TerminalRows
  public var book: TerminalHeightBook
  public var pendingApprovals: [PermissionRequest]
  /// Paint only — there is no store and no set affordance, the way the web
  /// client leaves it.
  public var bookmarks: [Int]
  public var recap: ScrubberRecap?
  public var viewportHeight: CGFloat

  public init(
    items: [TranscriptItem], rows: TerminalRows, book: TerminalHeightBook,
    pendingApprovals: [PermissionRequest] = [], bookmarks: [Int] = [],
    recap: ScrubberRecap? = nil, viewportHeight: CGFloat
  ) {
    self.items = items
    self.rows = rows
    self.book = book
    self.pendingApprovals = pendingApprovals
    self.bookmarks = bookmarks
    self.recap = recap
    self.viewportHeight = viewportHeight
  }

  public var totalSize: CGFloat { book.totalHeight }
}

// MARK: - Scale

/// The floor, not the height: a mark spans its row's actual extent at rail
/// scale, so a one-line prompt is a tick and a hundred-line response is a bar —
/// the rail is a map, and on a map a long answer looks long.
public let scrubberMinMark: CGFloat = 2

/// Rail points per content point — the one scale the marks and the viewport band
/// are both drawn at, so they cannot disagree about where a row sits.
///
/// The denominator is `max(totalSize, viewportHeight)` and **never `totalSize`
/// alone**. A transcript shorter than its viewport is the case that forces it:
/// with 90 points of content in a 906-point window, `railH / totalSize` is ~10
/// and the band comes out at 9,120 points inside a 906-point rail. The rail is
/// positioned *inside* the scroller, so that overflow becomes real scrollable
/// height — a short session grew ~8,000 points of empty space below it and the
/// reader could scroll away from the only three rows there were.
///
/// Clamped, the rail represents the **viewport** when everything fits (the band
/// fills it exactly), and `bandH` can never exceed `railH` again for any
/// content, because `viewportHeight` can never exceed the denominator.
public func railScale(railH: CGFloat, totalSize: CGFloat, viewportH: CGFloat) -> CGFloat {
  totalSize > 0 ? railH / max(totalSize, viewportH) : 0
}

// MARK: - Building the rail

/// One response mark per segment, emitted when the segment closes.
private struct ScrubberSegment {
  var response: Int?
  var turn: Int?
  var failed = false
}

/// Fold a transcript into the clusters a rail draws.
///
/// The response lane is anchored on **the answer, not the turn end**. Built from
/// `turn_result` alone it was silently history-blind: a resumed session's
/// backfill maps only user and assistant entries, so it carried no turn rows at
/// all and the whole lane came back empty — while the prompt lane survived,
/// which is what made it look like a rendering bug rather than a missing input.
/// So a `turn_result` *decorates* a mark rather than conjuring it.
public func buildScrubberClusters(_ input: ScrubberInput, railH: CGFloat) -> [ScrubberCluster] {
  var marks: [ScrubberMark] = []
  var segment = ScrubberSegment()

  func closeSegment() {
    if let anchor = segment.response ?? segment.turn {
      marks.append(
        ScrubberMark(
          kind: segment.failed ? .turnFailed : .turn, itemIndex: anchor,
          rowIndex: input.rows.rowIndex(forItem: anchor), turnIndex: segment.turn))
    }
    segment = ScrubberSegment()
  }

  // Which top-level calls a sub-agent ran inside — by `parentToolUseId` and
  // never by the spawning call's *name*: `Task` is the SDK's convention, not a
  // law (a background agent arrives as `Agent`), and an id that other items
  // demonstrably nest under IS a sub-agent whatever spawned it. The same
  // membership rule the fold uses, for the same reason.
  var subagentParents: Set<String> = []
  for item in input.items {
    if let parent = parentToolUseId(of: item) { subagentParents.insert(parent) }
  }

  // The **outcome** call of each row: the last top-level tool call the row
  // holds. A failed call is marked only if it is one of these — see
  // `toolFailed` below for why.
  var rowOutcome: [Int: Int] = [:]
  for (index, item) in input.items.enumerated() {
    guard case .toolCall = item, parentToolUseId(of: item) == nil else { continue }
    rowOutcome[input.rows.rowIndex(forItem: index)] = index
  }

  for (index, item) in input.items.enumerated() {
    // The dispatch itself, at its row — the folded `Task` block, so the band
    // grows to the whole sub-agent area when it is opened and shrinks back to a
    // tick when it is closed. Deliberately outside the switch: a `Task` whose
    // own result errored earns a red tick in the response lane *and* this band
    // in the input lane, which is the point of the two channels — one says a
    // sub-agent ran here, the other says it came back broken.
    if case .toolCall(let call) = item, subagentParents.contains(call.id) {
      marks.append(
        ScrubberMark(
          kind: .subagent, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))
    }

    switch item {
    // Top-level prompts only, like the answer check below: a subagent's brief is
    // a `user` item too, and it would both paint a "you" mark for something
    // nobody typed and close the segment mid-turn — mis-anchoring the response
    // mark whenever a task runs between the prompt and the answer.
    case .user where parentToolUseId(of: item) == nil:
      closeSegment()
      marks.append(
        ScrubberMark(kind: .user, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))

    case .turnResult(_, _, let isError, _, _, _):
      segment.turn = index
      segment.failed = isError
      closeSegment()

    case .notice(_, let level, _) where level == .error:
      marks.append(
        ScrubberMark(kind: .error, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))

    // **The rail marks what the transcript reddens** — that is the whole rule,
    // and it is why this is not simply `callFailed`.
    //
    // The row model already decided, twice, that a routine failure the model
    // recovered from is not a failure: `runFailed` colours a folded run by its
    // **last** call, and `taskFailed` colours a `Task` by its **own** result and
    // never a child's. Both were changed from `contains` for the same reason —
    // a normal working session came back painted red, and the colour that
    // should have been left for the one broken thing was spent on a grep that
    // matched nothing. The rail was deliberately exempted, on the argument that
    // its question ("is there anything in here worth navigating to") differs
    // from the row's ("how did this end").
    //
    // Measured against a real session, the exemption did not survive: 178 tool
    // calls, 9 failed, **8 of the 9 recovered from inside their own run**, no
    // failed turn and no session error — so the rail showed nine alarms for a
    // transcript that reddens one row. A red mark next to nothing red is worse
    // than no mark, because it sends a reader looking for damage that is not
    // there.
    //
    // One uniform test does all three cases, and needs no block lookup: a call
    // is its row's **outcome** when it is top level and no later top-level call
    // shares its row. For a folded run that is exactly `runFailed`'s last
    // member; for a lone call it is the call; and for a `Task` it is the task
    // itself, because its children are not top level — which is `taskFailed`,
    // spelled a third way and agreeing. A failed child inside a sub-agent is
    // therefore no longer marked, and that is the same call `taskFailed` makes:
    // an agent that ran a hundred calls, one of them that grep, did not fail.
    // The sub-agent band still says it ran, and its own red tick still says it
    // came back broken. Nothing is concealed either way — every failure is
    // still red on its own row, and the recap still counts every one.
    //
    // The disjunction inside `callFailed` is unchanged and both spellings are
    // still needed: an out-of-loop execution failure sets only the status, and
    // an engine can flag `is_error` on a call the reducer has not settled.
    case .toolCall(let call) where callFailed(call) && rowOutcome[input.rows.rowIndex(forItem: index)] == index:
      marks.append(
        ScrubberMark(
          kind: .toolFailed, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))

    // The live answer included, deliberately: a turn in flight has no turn end
    // yet, which left a two-minute answer unrepresented for the whole two
    // minutes it was the only thing worth navigating to. The mark's height is
    // its row's, so it grows as the answer does with no extra bookkeeping.
    case .assistantText(_, _, _, let parent) where parent == nil:
      segment.response = index

    default:
      break
    }
  }
  // A history that ends mid-segment still has an answer in it.
  closeSegment()

  for index in input.bookmarks where index >= 0 && index < input.items.count {
    marks.append(
      ScrubberMark(kind: .bookmark, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))
  }
  if let recap = input.recap {
    marks.append(ScrubberMark(kind: .recap, itemIndex: -1, rowIndex: recap.rowIndex))
  }

  let scale = railScale(railH: railH, totalSize: input.totalSize, viewportH: input.viewportHeight)
  var lanes: [ScrubberLane: [ScrubberMember]] = [:]
  var heights: [ScrubberLane: [CGFloat]] = [:]
  for mark in marks {
    // A mark's height is its row's, at rail scale, floored at the hit target —
    // the row the mark *anchors* (for a turn, the final response), which is
    // where the reader lands and what they came to gauge the size of.
    //
    // EXCEPT an item that SHARES its row (a task block's absorbed child, a
    // folded run's member): there the row's extent is mostly other items' work,
    // and expanded it is the whole subagent area — one failed child of a
    // hundred-call task used to paint a solid band down the entire rail. Such a
    // mark is a tick at its fractional position within the row.
    //
    // The height book already reflects expansion (it is planned from the live
    // `TerminalExpansion`), so collapsed the fraction rounds onto the row's one
    // line and siblings merge exactly as before. The fraction is deliberately
    // approximate — this renderer COULD compute a child's true line offset from
    // the book, and using the same fraction as the web client instead is what
    // keeps the two implementations one rule. Applied here rather than per kind
    // because a bookmark on an absorbed child has the identical bug; the recap
    // mark is `itemIndex: -1`, hence the guard.
    let within = mark.itemIndex >= 0 ? input.rows.position(forItem: mark.itemIndex) : nil
    let rowH = input.book.height(at: mark.rowIndex)
    let h = within != nil ? scrubberMinMark : max(scrubberMinMark, (rowH * scale).rounded())
    let offset =
      input.book.offset(at: mark.rowIndex)
      + (within.map { CGFloat($0.ordinal) / CGFloat($0.count) * rowH } ?? 0)
    let y = min(max(0, railH - h), (offset * scale).rounded())
    lanes[mark.kind.lane, default: []].append(ScrubberMember(mark: mark, y: y))
    heights[mark.kind.lane, default: []].append(h)
  }

  var clusters: [ScrubberCluster] = []
  // Sorted so the rail is deterministic: a dictionary's order is not, and this
  // list is diffed by a view.
  for lane in [ScrubberLane.left, .right, .full] {
    guard let members = lanes[lane], let laneHeights = heights[lane] else { continue }
    let sorted = zip(members, laneHeights).sorted { left, right in
      left.0.y == right.0.y ? left.0.mark.itemIndex < right.0.mark.itemIndex : left.0.y < right.0.y
    }
    var current: Int?
    for (member, h) in sorted {
      // Merge when the gap is under a point; the merged mark grows and takes the
      // loudest member's colour.
      if let index = current, member.y <= clusters[index].y + clusters[index].h + 1 {
        clusters[index].h = max(clusters[index].h, member.y + h - clusters[index].y)
        if member.mark.kind.loudness > clusters[index].kind.loudness {
          clusters[index].kind = member.mark.kind
        }
        clusters[index].marks.append(member)
        continue
      }
      clusters.append(
        ScrubberCluster(
          lane: lane, kind: member.mark.kind, y: member.y, h: h, marks: [member]))
      current = clusters.count - 1
    }
  }

  // The approval is not an item — the prompt renders below the transcript — so
  // its mark pins at the rail's foot, where the prompt is.
  if !input.pendingApprovals.isEmpty {
    clusters.append(
      ScrubberCluster(
        lane: ScrubberMarkKind.approval.lane, kind: .approval,
        y: max(0, railH - scrubberMinMark), h: scrubberMinMark, marks: []))
  }
  return clusters
}

// MARK: - The peek

/// What the peek says, as data. The strings live here for the reason every
/// string in this theme does — and because the row a peek describes is usually
/// unmounted, so there is nothing on screen to read them off.
public struct ScrubberPeek: Equatable, Sendable {
  public struct Line: Equatable, Sendable {
    public var text: String
    public var tone: TermTone
    /// Clipped to a couple of lines by the view — a peek is a glance, not a row.
    public var excerpt: Bool

    public init(text: String, tone: TermTone, excerpt: Bool = false) {
      self.text = text
      self.tone = tone
      self.excerpt = excerpt
    }
  }

  public var title: String
  public var lines: [Line]
}

public func scrubberPeek(
  cluster: ScrubberCluster, mark: ScrubberMark?, input: ScrubberInput
) -> ScrubberPeek {
  let more = cluster.marks.count > 1 ? " · \(cluster.marks.count) marks" : ""
  let title = (mark?.kind ?? cluster.kind).name + more
  var lines: [ScrubberPeek.Line] = []

  func excerptText(_ item: TranscriptItem) -> String {
    switch item {
    case .user(_, let text, _, _): return text
    case .assistantText(_, let text, _, _): return text
    case .thinking(_, let text, _): return text
    case .notice(_, _, let text): return text
    case .toolCall(let call): return "\(call.name)(\(TermFmt.toolInputPreview(call.input)))"
    case .turnResult: return doneLine(item) ?? ""
    case .fileDelivered(_, let path, _, _): return path
    }
  }

  if cluster.kind == .approval {
    if let request = input.pendingApprovals.first {
      lines.append(.init(text: request.title ?? "Permission required", tone: .bright))
      lines.append(
        .init(
          text:
            "\(request.displayName ?? request.toolName)(\(TermFmt.toolInputPreview(request.input)))",
          tone: .fg, excerpt: true))
    }
    return ScrubberPeek(title: title, lines: lines)
  }

  guard let mark else {
    if cluster.kind == .recap, let recap = input.recap {
      lines.append(.init(text: "\(TermGlyph.recap) \(recap.label)", tone: .faint))
    }
    return ScrubberPeek(title: title, lines: lines)
  }

  if mark.kind == .recap {
    if let recap = input.recap {
      lines.append(.init(text: "\(TermGlyph.recap) \(recap.label)", tone: .faint))
    }
    return ScrubberPeek(title: title, lines: lines)
  }

  let item = mark.itemIndex >= 0 && mark.itemIndex < input.items.count
    ? input.items[mark.itemIndex] : nil

  if mark.kind == .turn || mark.kind == .turnFailed {
    // The merged mark's peek carries both halves: the message the turn ended on,
    // and the done-line, with its reasons when it failed.
    if case .assistantText(_, let text, _, _) = item {
      lines.append(.init(text: "\(TermGlyph.bullet) \(text)", tone: .fg, excerpt: true))
    }
    if let turnIndex = mark.turnIndex, turnIndex < input.items.count,
      case .turnResult(_, _, let isError, _, _, let errors) = input.items[turnIndex]
    {
      if let done = doneLine(input.items[turnIndex]) {
        lines.append(.init(text: done, tone: isError ? .red : .faint))
      }
      for message in errors ?? [] { lines.append(.init(text: message, tone: .red)) }
    }
    return ScrubberPeek(title: title, lines: lines)
  }

  guard let item else { return ScrubberPeek(title: title, lines: lines) }
  let alarm = mark.kind == .error || mark.kind == .toolFailed
  let prefix = mark.kind == .user ? "\(TermGlyph.prompt) " : ""
  lines.append(.init(text: prefix + excerptText(item), tone: alarm ? .red : .fg, excerpt: true))
  // Which tool failed is rarely the question — `Bash(pnpm test)` is what you
  // already expected to see. The first non-blank line of what it said back is
  // the thing worth peeking at.
  if mark.kind == .toolFailed, case .toolCall(let call) = item,
    let failure = call.result?.text.components(separatedBy: "\n").first(where: {
      !$0.trimmingCharacters(in: .whitespaces).isEmpty
    })
  {
    lines.append(.init(text: failure, tone: .red, excerpt: true))
  }
  return ScrubberPeek(title: title, lines: lines)
}

private func doneLine(_ item: TranscriptItem?) -> String? {
  guard case .turnResult(_, let subtype, let isError, let durationMs, let cost, _) = item else {
    return nil
  }
  return "\(isError ? subtype : "done") · \(TermFmt.duration(ms: durationMs)) · \(TermFmt.cost(cost))"
}
