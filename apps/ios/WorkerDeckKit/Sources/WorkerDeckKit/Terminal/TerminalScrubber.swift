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

/// A stretch of the rail that is **ground rather than a point** — painted under
/// the marks, and inert.
///
/// It exists because `.expanded` was a `ScrubberMarkKind` and needed three
/// exemptions from the mark machinery inside an hour: skip the ``RowPosition``
/// fractional rule (every other mark denotes an *item*, which may share its row;
/// this one denotes the **row**), never merge (merging paints a cluster in its
/// loudest member's colour, which is right for ticks a pixel apart and
/// catastrophic for a band — an opened tool inside an opened run once swallowed
/// every prompt in the lane and turned the rail blue), and paint first (a band
/// drawn in list order covers the very failures and prompts inside the part you
/// opened). Three exemptions for one case is the type saying it is the wrong
/// type; a region needs none of them, because none of those rules is *about* a
/// region.
///
/// A fourth thing falls out and was a latent bug: regions do not answer the
/// finger. A band spans hundreds of points, so under ``ScrubberCluster``'s
/// nearest-cluster arithmetic it tied with — and could beat — the marks inside
/// it, jumping the reader to the top of a region instead of to the prompt they
/// pressed. A region is context for what surrounds it, never the thing you
/// navigate to.
public struct ScrubberRegion: Equatable, Sendable {
  public var lane: ScrubberLane
  public var kind: ScrubberRegionKind
  public var y: CGFloat
  public var h: CGFloat
  public var rowIndex: Int
}

public enum ScrubberRegionKind: String, Equatable, Sendable {
  /// Every block you opened, banded over the rows it grew to.
  ///
  /// The **left** lane, because opening is something *you* did, which is what
  /// that lane holds — the prompts you typed and the sub-agents you dispatched.
  /// It is also the only way the rail can say that the tall stretch under your
  /// thumb is tall because you opened it rather than because the session
  /// produced that much.
  case expanded

  public var lane: ScrubberLane {
    switch self {
    case .expanded: return .left
    }
  }
}

/// What the rail draws: ground, then marks.
///
/// The order is structural now rather than a `sorted(by:)` in the view — a
/// painter draws ``regions`` and then ``clusters``, and cannot get it wrong.
public struct ScrubberRail: Equatable, Sendable {
  public var regions: [ScrubberRegion]
  public var clusters: [ScrubberCluster]
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
  /// Bookmarked transcript item **ids** — the reader's own annotations, set by
  /// the row's long-press menu and kept by the host (the app's `BookmarkModel`
  /// over the kit's `Bookmarks`), the same seam the web passes as
  /// `SessionPanelProps.bookmarks`. Ids rather than indices because an index is
  /// an artifact of one replay's coalescing and an id survives it; the id →
  /// index translation happens in `scrubberMarks`, where the items are — the
  /// port of web `TranscriptRows.tsx`'s `bookmarkIndexes`. An id not in `items`
  /// simply draws nothing, and that is what lets **one set ride every rail**:
  /// inside a takeover frame the same bookmarks resolve against the frame's own
  /// items or stay off it, with no full-transcript index space to get wrong —
  /// the hazard that kept the index-addressed version of this field out of
  /// frames entirely.
  public var bookmarks: [String]
  public var recap: ScrubberRecap?
  public var viewportHeight: CGFloat
  /// What is open, because **what the rail marks depends on it** — see
  /// `redItemIndices`. The book is already built with the same value; this is
  /// the one rule that needs to read it rather than measure its effect.
  public var expansion: TerminalExpansion
  /// The sub-agent takeover's parent id, when this rail belongs to a frame.
  ///
  /// **It is what "top level" means here.** Two of the mark rules below mark
  /// only items at the rail's own level, so that at the top a sub-agent's work
  /// is represented by the one band its `Task` row gets rather than by a second
  /// set of prompts and answers threaded through the rail. Inside a frame that
  /// same test excluded *everything* — every item there has a parent by
  /// construction — and the rail came out **mounted, banded, and marking
  /// nothing** on a hundred-tool agent. So the level is a parameter: `nil` at
  /// the top, the frame's id inside one. The port of web
  /// `TerminalScrubberProps.frameParentId` (`scrubber.tsx`).
  public var frameParentId: String?

  public init(
    items: [TranscriptItem], rows: TerminalRows, book: TerminalHeightBook,
    pendingApprovals: [PermissionRequest] = [], bookmarks: [String] = [],
    recap: ScrubberRecap? = nil, viewportHeight: CGFloat,
    // **No default.** The book is built with an expansion too, and a caller who
    // passed it there and omitted it here would get a rail quietly describing a
    // transcript that is not on screen — marks for a fold nobody is looking at,
    // and none for the one they opened. Required, so the compiler asks.
    expansion: TerminalExpansion,
    // **No default, for the expansion's reason.** The rows and the book are
    // built from the frame's items, and a caller who framed them there and
    // omitted the level here would get the empty rail back — mounted, banded,
    // and marking nothing. Required, so the compiler asks.
    frameParentId: String?
  ) {
    self.items = items
    self.rows = rows
    self.book = book
    self.pendingApprovals = pendingApprovals
    self.bookmarks = bookmarks
    self.recap = recap
    self.viewportHeight = viewportHeight
    self.expansion = expansion
    self.frameParentId = frameParentId
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

// MARK: - What the rail marks

/// The transcript indices of tool calls **drawn red on a line of their own** —
/// exactly what the rail paints a failure mark for.
///
/// The rule is one sentence: *if it is red in the transcript, it is red on the
/// rail*. Everything below is that sentence applied to a fold.
///
/// It has been wrong in both directions. It began as "every failed call", which
/// against a real session meant 178 calls, 9 failures, **8 of them recovered
/// from inside their own run**, and nine alarms on a rail whose transcript
/// reddened one row — a red mark beside nothing red sends a reader hunting for
/// damage that is not there. Narrowing it to each row's *outcome* fixed that and
/// broke the other half: open a run and one of its calls is visibly red on its
/// own line with nothing on the rail beside it.
///
/// A fold is what reconciles them, and the fold is stated **once**, in
/// ``BlockCall/ownLine`` — which is why this function is now four lines. It used
/// to re-derive that rule here, from the same leaf predicates as the planner but
/// by separate reasoning, in the same nested item/run/task switch that
/// `expansionKeys` and `truncatedCallIds` also each carried a copy of. Four
/// walks of one shape, and the sentence above is precisely a claim that two of
/// them agree.
///
/// It reads `expansion` rather than measuring the book because mark *existence*
/// is not derivable from a height the way a mark's extent and fraction are.
///
/// It is also why a frame needs no special case here: the web's `rowOutcome`
/// map tests "is this call at the rail's level" and had to learn
/// `frameParentId`, but this walks the rows it was handed — inside a takeover
/// those are the frame's own fold, so what the frame reddens is already exactly
/// what it marks.
public func redItemIndices(rows: TerminalRows, expansion: TerminalExpansion) -> Set<Int> {
  var red: Set<Int> = []
  for row in rows.rows {
    guard case .block(let block) = row else { continue }
    for drawn in blockCalls(in: block, expansion: expansion)
    where drawn.ownLine && callFailed(drawn.call) {
      red.insert(drawn.index)
    }
  }
  return red
}

// MARK: - Building the rail

/// One response mark per segment, emitted when the segment closes.
private struct ScrubberSegment {
  var response: Int?
  var turn: Int?
  var failed = false
}

/// Fold a transcript into the rail it draws: ground, then marks.
///
/// The response lane is anchored on **the answer, not the turn end**. Built from
/// `turn_result` alone it was silently history-blind: a resumed session's
/// backfill maps only user and assistant entries, so it carried no turn rows at
/// all and the whole lane came back empty — while the prompt lane survived,
/// which is what made it look like a rendering bug rather than a missing input.
/// So a `turn_result` *decorates* a mark rather than conjuring it.
public func buildScrubberRail(_ input: ScrubberInput, railH: CGFloat) -> ScrubberRail {
  let scale = railScale(railH: railH, totalSize: input.totalSize, viewportH: input.viewportHeight)
  return ScrubberRail(
    regions: expandedRegions(input, scale: scale, railH: railH),
    clusters: clusterMarks(
      scrubberMarks(input), input: input, scale: scale, railH: railH))
}

/// The marks alone, for a caller that only wants the points.
public func buildScrubberClusters(_ input: ScrubberInput, railH: CGFloat) -> [ScrubberCluster] {
  buildScrubberRail(input, railH: railH).clusters
}

// MARK: - Marks

/// Every point on the rail, in transcript order, before any geometry.
private func scrubberMarks(_ input: ScrubberInput) -> [ScrubberMark] {
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
  // membership rule the fold uses, for the same reason. Inside a frame this
  // finds only the frame's own id, which no frame item carries as its own — a
  // grandchild's parent is a frame *call* and `subagentItems` excludes
  // grandchildren — so a frame's rail draws no band for itself.
  var subagentParents: Set<String> = []
  for item in input.items {
    if let parent = parentToolUseId(of: item) { subagentParents.insert(parent) }
  }

  // Which failures are on screen as failures — see `redItemIndices`.
  let red = redItemIndices(rows: input.rows, expansion: input.expansion)

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
    // Prompts at the rail's own level — `frameParentId`, nil at the top — like
    // the answer check below: at the top a subagent's brief is a `user` item
    // too, and it would both paint a "you" mark for something nobody typed and
    // close the segment mid-turn — mis-anchoring the response mark whenever a
    // task runs between the prompt and the answer.
    case .user where parentToolUseId(of: item) == input.frameParentId:
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

    // **If it is red in the transcript, it is red on the rail** — the whole
    // rule, and why this defers to `redItemIndices` rather than testing the
    // call. That function owns the fold-aware half; the disjunction inside
    // `callFailed` is unchanged, and both its spellings are still needed (an
    // out-of-loop execution failure sets only the status, and an engine can
    // flag `is_error` on a call the reducer has not settled).
    case .toolCall where red.contains(index):
      marks.append(
        ScrubberMark(
          kind: .toolFailed, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))

    case .assistantText(_, _, _, let parent) where parent == input.frameParentId:
      if input.frameParentId != nil {
        // **Inside a frame every narration step is its own mark**, where the
        // conversation gets one per segment. The segment machinery has nothing
        // to work with here — a sub-agent's stream carries no prompts and no
        // `turn_result`, so every step would fold into a single mark at the
        // final report, which is the one place a reader can already get to. An
        // agent's rail is a list of what it said on the way, and that is what
        // makes a fifty-step run navigable.
        marks.append(
          ScrubberMark(
            kind: .turn, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))
      } else {
        // The live answer included, deliberately: a turn in flight has no turn
        // end yet, which left a two-minute answer unrepresented for the whole
        // two minutes it was the only thing worth navigating to. The mark's
        // height is its row's, so it grows as the answer does with no extra
        // bookkeeping.
        segment.response = index
      }

    default:
      break
    }
  }
  // A history that ends mid-segment still has an answer in it.
  closeSegment()

  // Hosts hand bookmarks over as item ids (stable across replays); the mark
  // model positions by index, so the translation lives here, where the items
  // are — mirroring web `TranscriptRows.tsx`. An id this transcript does not
  // hold (a frame that doesn't contain it, a truncated replay) simply draws
  // nothing. Each resolved index still goes through `rowIndex(forItem:)` like
  // every other mark: the id names an *item*, and which row shows an item is a
  // membership question no arithmetic can answer.
  if !input.bookmarks.isEmpty {
    var indexById: [String: Int] = [:]
    for (index, item) in input.items.enumerated() { indexById[item.id] = index }
    for id in input.bookmarks {
      guard let index = indexById[id] else { continue }
      marks.append(
        ScrubberMark(
          kind: .bookmark, itemIndex: index, rowIndex: input.rows.rowIndex(forItem: index)))
    }
  }
  if let recap = input.recap {
    marks.append(ScrubberMark(kind: .recap, itemIndex: -1, rowIndex: recap.rowIndex))
  }
  return marks
}

// MARK: - Geometry

/// Where a mark sits on the rail, and how tall it is.
///
/// A mark's height is its row's, at rail scale, floored at the hit target — the
/// row the mark *anchors* (for a turn, the final response), which is where the
/// reader lands and what they came to gauge the size of.
///
/// EXCEPT an item that **shares** its row (a task block's absorbed child, a
/// folded run's member): there the row's extent is mostly other items' work, and
/// expanded it is the whole subagent area — one failed child of a hundred-call
/// task used to paint a solid band down the entire rail. Such a mark is a tick
/// at its fractional position within the row.
///
/// The height book already reflects expansion (it is planned from the live
/// `TerminalExpansion`), so collapsed the fraction rounds onto the row's one line
/// and siblings merge exactly as before. The fraction is deliberately
/// approximate — this renderer COULD compute a child's true line offset from the
/// book, and using the same fraction as the web client instead is what keeps the
/// two implementations one rule. Applied to every kind rather than per kind
/// because a bookmark on an absorbed child has the identical bug; the recap mark
/// is `itemIndex: -1`, hence the guard.
private func place(_ mark: ScrubberMark, input: ScrubberInput, scale: CGFloat, railH: CGFloat)
  -> (y: CGFloat, h: CGFloat)
{
  let within = mark.itemIndex >= 0 ? input.rows.position(forItem: mark.itemIndex) : nil
  let rowH = input.book.height(at: mark.rowIndex)
  let h = within != nil ? scrubberMinMark : max(scrubberMinMark, (rowH * scale).rounded())
  let offset =
    input.book.offset(at: mark.rowIndex)
    + (within.map { CGFloat($0.ordinal) / CGFloat($0.count) * rowH } ?? 0)
  return (min(max(0, railH - h), (offset * scale).rounded()), h)
}

/// Every block you opened, banded over the rows it grew to.
///
/// The extent comes from the book, which is already built with this expansion,
/// so a band is the opened height with no extra bookkeeping — and a *row's*
/// height, never an item's, which is what makes this a region and not a mark
/// (see ``ScrubberRegion``).
///
/// Asked through `expansionKeys`, **never a block's own key**: a block has more
/// than one, and for two common shapes its own is not the one a press writes. A
/// run of one is drawn as the call itself, so it toggles `.call` and its `.run`
/// key does not exist at all — which is why expanding a lone top-level `Bash`
/// banded nothing. A call opened *inside* an already-open run toggles its own
/// key too. One row can hold several of these; it is one band either way,
/// because it is one row.
private func expandedRegions(_ input: ScrubberInput, scale: CGFloat, railH: CGFloat)
  -> [ScrubberRegion]
{
  var regions: [ScrubberRegion] = []
  for (rowIndex, row) in input.rows.rows.enumerated() {
    // The *row* overload, not the block's: the takeover's brief row is
    // synthetic but it is a thing you can open (`ExpansionKey.brief`), and an
    // opened brief is opened height the same as any block's. The recap row has
    // no keys and never bands.
    let keys = expansionKeys(of: row)
    guard keys.contains(where: input.expansion.isOpen) else { continue }
    let rowH = input.book.height(at: rowIndex)
    let h = max(scrubberMinMark, (rowH * scale).rounded())
    let y = min(max(0, railH - h), (input.book.offset(at: rowIndex) * scale).rounded())
    regions.append(
      ScrubberRegion(
        lane: ScrubberRegionKind.expanded.lane, kind: .expanded, y: y, h: h, rowIndex: rowIndex))
  }
  return regions
}

/// Marks into the bars a rail paints: laned, sorted, and merged under a point.
private func clusterMarks(
  _ marks: [ScrubberMark], input: ScrubberInput, scale: CGFloat, railH: CGFloat
) -> [ScrubberCluster] {
  var lanes: [ScrubberLane: [(ScrubberMember, CGFloat)]] = [:]
  for mark in marks {
    let (y, h) = place(mark, input: input, scale: scale, railH: railH)
    lanes[mark.kind.lane, default: []].append((ScrubberMember(mark: mark, y: y), h))
  }

  var clusters: [ScrubberCluster] = []
  // Sorted so the rail is deterministic: a dictionary's order is not, and this
  // list is diffed by a view.
  for lane in [ScrubberLane.left, .right, .full] {
    guard let members = lanes[lane] else { continue }
    let sorted = members.sorted { left, right in
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
        ScrubberCluster(lane: lane, kind: member.mark.kind, y: member.y, h: h, marks: [member]))
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
