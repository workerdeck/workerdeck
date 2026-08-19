import SwiftUI
import WorkerDeckKit

/// The overview ruler, drawn.
///
/// Everything it decides has already been decided in `TerminalScrubber.swift`:
/// which marks exist, which lane each sits in, where they merge and what a peek
/// says. What is left here is paint, one gesture, and the two things a phone
/// changes about the web client's design.
///
/// **There is no hover.** On the web a pointer resting on a mark opens the peek
/// and a drag scrubs, and the two are separate — the peek is *dismissed* the
/// moment a drag starts. A finger has no resting state, so the peek would be
/// unreachable under that rule. Here a drag scrubs **and** peeks what it is
/// passing, which is what a scrubber is for; a clean press with no travel is a
/// jump on a mark and a scroll-to-here on the ground, exactly as on the web.
///
/// **Twelve points is not a touch target.** The paint is the theme's 12 — the
/// one place the `ch` rule is set aside, because the rail is chrome beside the
/// grid rather than a column of text — and the *hit area* is wider than the
/// paint. Not the full 44 the HIG asks for a discrete control: this strip sits
/// over the transcript's right edge, which is where a right thumb scrolls, and
/// taking 44 points of that away costs more than the rail gains.
///
/// It is a `Canvas` and not a view per mark for the reason the rail exists at
/// all: a long session merges into hundreds of clusters, and this repaints on
/// every scroll tick. Hit-testing is arithmetic over the same clusters — there
/// are no views to hit.
struct TerminalScrubberView: View {
  let input: ScrubberInput
  let scroll: TranscriptScrollModel
  let typography: TerminalTypography
  var onJumpToRow: (Int) -> Void

  /// The paint, in points. The theme's 12.
  static let railWidth: CGFloat = 12
  /// What answers the finger. See the type comment for why it is not 44.
  static let hitWidth: CGFloat = 28
  private static let laneWidth: CGFloat = 6
  /// How far a touch may travel before it stops being a press and starts being
  /// a scrub.
  private static let slop: CGFloat = 3

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var peek: Peek?
  @State private var dragging = false

  private struct Peek: Equatable {
    var cluster: ScrubberCluster
    var mark: ScrubberMark?
    var y: CGFloat
  }

  var body: some View {
    // Full width, with only the strip at the trailing edge answering touches.
    //
    // The obvious shape — a 28-point view holding everything — cannot lay the
    // peek out: the panel is wider than its container, so its position comes out
    // of overflow arithmetic and it hangs off the screen. Here the peek is a HUD
    // in the transcript's own coordinate space, where "beside the rail, never
    // past the edge" is ordinary trailing alignment, and the rail stays a
    // control that happens to be narrow.
    GeometryReader { proxy in
      let railH = proxy.size.height
      let clusters = buildScrubberClusters(input, railH: railH)

      ZStack(alignment: .topTrailing) {
        Canvas { context, _ in
          draw(clusters: clusters, in: &context)
        }
        .frame(width: Self.railWidth)
        .allowsHitTesting(false)

        // Filtered, never a `ForEach` over every cluster with a test inside: a
        // dense rail merges into hundreds of them, and there is at most one
        // approval.
        if let approval = clusters.first(where: { $0.kind == .approval }) {
          approvalMark(approval)
            .frame(width: Self.railWidth)
            .allowsHitTesting(false)
        }

        // Its own view, and that is a performance decision rather than tidiness:
        // the band is the only thing here that changes with the scroll offset,
        // and observation is per view body. Read the offset in *this* body and
        // every scroll tick would rebuild every cluster — O(session) work per
        // frame of a fling, for output that only changes when content does. The
        // web client reaches the same place with a `useMemo`.
        ScrubberBandView(
          scroll: scroll, totalSize: input.totalSize, railH: railH, width: Self.railWidth)
          .frame(width: Self.railWidth)
          .allowsHitTesting(false)

        if let peek {
          peekPanel(peek, railH: railH, available: proxy.size.width)
        }

        // The strip that answers the finger, last so it is on top.
        Color.clear
          .frame(width: Self.hitWidth)
          .contentShape(Rectangle())
          .gesture(gesture(clusters: clusters, railH: railH))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
    }
  }

  // MARK: - Paint

  private func draw(clusters: [ScrubberCluster], in context: inout GraphicsContext) {
    for cluster in clusters {
      let rect = CGRect(
        x: laneX(cluster.lane), y: cluster.y, width: laneW(cluster.lane), height: cluster.h)
      switch cluster.kind {
      case .user: twoTone(rect, TerminalPalette.color(.blue), in: &context)
      // Green, because every other colour on this rail is spoken for and none of
      // them means "somebody else's working": blue is you, white is the answer,
      // red is an alarm, magenta is your bookmark, yellow is the session waiting
      // on you. An extent like the two beside it — collapsed a tick, expanded
      // the band the sub-agent covers.
      case .subagent: twoTone(rect, TerminalPalette.color(.green), in: &context)
      // Yellow, matching the wash the opened rows themselves carry — the rail
      // and the region are saying the same thing and should say it in the same
      // colour. It still loses every merge, so an opened `Task` keeps its green
      // and a prompt inside the region keeps its blue.
      case .expanded: twoTone(rect, TerminalPalette.color(.yellow), in: &context)
      case .turn: twoTone(rect, TerminalPalette.color(.fg), in: &context)
      case .turnFailed: twoTone(rect, TerminalPalette.color(.red), in: &context)
      // The alarms stay solid: they are alarms, not extents.
      case .error:
        context.fill(Path(rect), with: .color(TerminalPalette.color(.red)))
      case .toolFailed:
        // 55%, and this is the one thing keeping the rail readable. A session
        // error is rare and a turn failure rarer; a tool that failed and was
        // recovered from is routine — a grep that matched nothing, a build fixed
        // on the second go — and at full strength a normal working session
        // paints the rail solid red, at which point the two failures that
        // actually ended something stop standing out.
        context.fill(Path(rect), with: .color(TerminalPalette.color(.red).opacity(0.55)))
      case .bookmark:
        context.fill(Path(rect), with: .color(TerminalPalette.color(.magenta)))
      case .approval:
        // Drawn outside the canvas so it can pulse — see `approvalMark`.
        break
      case .recap:
        // A dashed hairline centred in its box.
        var line = Path()
        let y = (rect.midY).rounded()
        line.move(to: CGPoint(x: rect.minX, y: y))
        line.addLine(to: CGPoint(x: rect.maxX, y: y))
        context.stroke(
          line, with: .color(TerminalPalette.color(.faint)),
          style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
      }
    }

  }

  /// A lane mark is two-tone: the first 2 points — the mark's own anchor — at
  /// full strength, the rest of the row's extent a 25% tail, so a long answer
  /// reads as long without a tall solid bar shouting over the rail.
  private func twoTone(_ rect: CGRect, _ color: Color, in context: inout GraphicsContext) {
    let head = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: min(2, rect.height))
    if rect.height > 2 {
      let tail = CGRect(
        x: rect.minX, y: rect.minY + 2, width: rect.width, height: rect.height - 2)
      context.fill(Path(tail), with: .color(color.opacity(0.25)))
    }
    context.fill(Path(head), with: .color(color))
  }

  /// The waiting approval, pulsing.
  ///
  /// A view rather than a canvas fill, because a canvas is drawn once per body
  /// evaluation and a clock read inside one does not animate — the same reason
  /// the transcript's working glyph is a `TimelineView`. Off under Reduce
  /// Motion, where the mark simply stands: it is yellow and full-width either
  /// way, which is the signal.
  @ViewBuilder private func approvalMark(_ cluster: ScrubberCluster) -> some View {
    let bar = Rectangle()
      .fill(TerminalPalette.color(.yellow))
      .frame(width: Self.railWidth, height: cluster.h)
      .offset(y: cluster.y)
      .frame(maxHeight: .infinity, alignment: .top)
    if reduceMotion {
      bar
    } else {
      TimelineView(.periodic(from: .now, by: 0.6)) { context in
        let lit = Int(context.date.timeIntervalSinceReferenceDate / 0.6) % 2 == 0
        bar.opacity(lit ? 1 : 0.3)
      }
    }
  }

  private func laneX(_ lane: ScrubberLane) -> CGFloat {
    switch lane {
    case .left, .full: return 0
    case .right: return Self.laneWidth
    }
  }

  private func laneW(_ lane: ScrubberLane) -> CGFloat {
    lane == .full ? Self.railWidth : Self.laneWidth
  }

  // MARK: - The peek

  /// Height without measuring, from the strings and the line — the same claim
  /// the whole theme makes. A measured panel would need a layout pass before it
  /// could be positioned, and it is positioned while a finger is moving.
  private func peekHeight(_ content: ScrubberPeek) -> CGFloat {
    let lines = 1 + content.lines.reduce(0) { $0 + ($1.excerpt ? 2 : 1) }
    return CGFloat(lines) * typography.line + 12
  }

  @ViewBuilder private func peekPanel(_ peek: Peek, railH: CGFloat, available: CGFloat)
    -> some View
  {
    let content = scrubberPeek(cluster: peek.cluster, mark: peek.mark, input: input)
    let height = peekHeight(content)
    // Never wider than what is beside the rail. A peek is a glance; a panel that
    // covered the transcript would be answering a question nobody asked.
    let width = min(260, max(120, available - Self.railWidth - 24))
    VStack(alignment: .leading, spacing: 0) {
      Text(content.title)
        .foregroundStyle(TerminalPalette.color(.faint))
        .frame(height: typography.line, alignment: .leading)
      ForEach(Array(content.lines.enumerated()), id: \.offset) { _, line in
        Text(line.text)
          .foregroundStyle(TerminalPalette.color(line.tone))
          .lineLimit(line.excerpt ? 2 : 1)
          .frame(alignment: .leading)
      }
    }
    .font(typography.font)
    .multilineTextAlignment(.leading)
    .padding(6)
    .frame(width: width, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 4))
    .overlay(
      RoundedRectangle(cornerRadius: 4).stroke(TerminalPalette.color(.faint).opacity(0.4)))
    // Beside the mark, clamped into the rail — a peek near either end would
    // otherwise hang off the transcript.
    // Beside the rail, and clamped into it vertically — a peek near either end
    // would otherwise hang off the transcript. The height is computed rather
    // than measured because this is positioned while a finger is moving, and a
    // measured panel needs a layout pass before it can be placed.
    .padding(.trailing, Self.railWidth + 4)
    .offset(y: max(4, min(railH - height - 4, peek.y - height / 2)))
    .allowsHitTesting(false)
    .transition(.opacity)
  }

  // MARK: - The gesture

  private func gesture(clusters: [ScrubberCluster], railH: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { value in
        let travelled = abs(value.translation.height) >= Self.slop
        if travelled { dragging = true }
        if dragging {
          scrub(to: value.location.y, railH: railH)
        }
        // Peek throughout, travelled or not: with no hover this is the only way
        // to see what a mark is before committing to it, and while scrubbing it
        // is the thumbnail strip that makes scrubbing worth doing.
        showPeek(at: value.location, clusters: clusters, railH: railH)
      }
      .onEnded { value in
        let wasDragging = dragging
        dragging = false
        peek = nil
        guard !wasDragging else { return }
        // A clean press: on a mark it is a jump, on the ground a scroll to
        // here — scrollbar semantics.
        if let cluster = cluster(at: value.location, clusters: clusters),
          let mark = cluster.nearestMember(to: value.location.y)
        {
          onJumpToRow(mark.rowIndex)
        } else if let cluster = cluster(at: value.location, clusters: clusters),
          cluster.kind == .approval
        {
          // The approval has no member to resolve to — the prompt is below the
          // transcript, so the bottom is where it lives.
          scroll.scrollToBottom()
        } else {
          scrub(to: value.location.y, railH: railH)
        }
      }
  }

  private func scrub(to y: CGFloat, railH: CGFloat) {
    guard railH > 0, input.totalSize > 0 else { return }
    let fraction = min(1, max(0, y / railH))
    // Content space, not a row: a rail drag is continuous and a row is not, so
    // snapping to row boundaries would turn a hundred-line answer into a dead
    // zone the transcript jumps across. Centred on the finger, the way a
    // scrollbar drag reads — the point you are holding is the middle of what you
    // are looking at, not its top edge.
    scroll.scrollTo(contentOffset: fraction * input.totalSize - scroll.viewportHeight / 2)
  }

  /// Which cluster is under a touch. Arithmetic, not hit-testing: the marks are
  /// painted into one canvas and there are no views to ask.
  private func cluster(at point: CGPoint, clusters: [ScrubberCluster]) -> ScrubberCluster? {
    // The touch's x in rail space — the hit area is wider than the paint, so a
    // press left of the rail still resolves, and to the lane it is nearest.
    // The gesture rides the hit strip, so its x is already strip-local: the
    // strip's trailing edge is the rail's, and the rail is its last 12 points.
    let x = point.x - (Self.hitWidth - Self.railWidth)
    var best: (cluster: ScrubberCluster, distance: CGFloat)?
    for cluster in clusters {
      let minX = laneX(cluster.lane)
      let maxX = minX + laneW(cluster.lane)
      // A press outside the rail's width belongs to whichever lane it is nearest
      // rather than to none.
      let laneMiss = x < minX ? minX - x : (x > maxX ? x - maxX : 0)
      let vertical =
        point.y < cluster.y
        ? cluster.y - point.y : (point.y > cluster.y + cluster.h ? point.y - cluster.y - cluster.h : 0)
      // A mark can be two points tall; without slop it is unpressable.
      guard vertical <= 8 else { continue }
      let distance = vertical * 2 + laneMiss
      if best == nil || distance < best!.distance { best = (cluster, distance) }
    }
    return best?.cluster
  }

  private func showPeek(at point: CGPoint, clusters: [ScrubberCluster], railH: CGFloat) {
    guard let cluster = cluster(at: point, clusters: clusters) else {
      if peek != nil { peek = nil }
      return
    }
    // A chain-merged bar can span the rail; sliding along it retargets the peek
    // to the member under the finger.
    let mark = cluster.nearestMember(to: point.y)
    let y = min(max(point.y, cluster.y), cluster.y + cluster.h)
    let next = Peek(cluster: cluster, mark: mark, y: y)
    if peek != next { peek = next }
  }
}

/// The viewport band — where you are.
///
/// Separated from the rail because it is the one part that follows the scroll,
/// and observation invalidates a whole body: drawn together, every scroll tick
/// would rebuild every cluster.
///
/// It deliberately carries no second indicator on its leading edge. With the
/// band already outlined that was one fact said twice, in the loudest colour on
/// the rail.
private struct ScrubberBandView: View {
  let scroll: TranscriptScrollModel
  let totalSize: CGFloat
  let railH: CGFloat
  let width: CGFloat

  var body: some View {
    let scale = railScale(railH: railH, totalSize: totalSize, viewportH: scroll.viewportHeight)
    let h = max(2, min(railH, (scroll.viewportHeight * scale).rounded()))
    // Clamped at the foot as well as the head: an overscroll bounce drives the
    // offset past the end for a frame or two, and the band is the one thing here
    // whose top is not already bounded by its own height.
    let y = max(0, min(railH - h, (scroll.contentOffset * scale).rounded()))
    Rectangle()
      .fill(TerminalPalette.color(.faint).opacity(0.25))
      .overlay(Rectangle().stroke(TerminalPalette.color(.faint), lineWidth: 1))
      .frame(width: width, height: h)
      .offset(y: y)
      .frame(maxHeight: .infinity, alignment: .top)
  }
}
