import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The overview rail over the core's clusters, Android's ScrubberRail in SwiftUI: the core places, merges and hit-tests
// every mark and answers the peek, so this only paints and forwards the finger. A drag scrubs and peeks; a clean press
// jumps to the mark under it, or scrolls to there on bare rail.
struct CoreScrubberRail: View {
  let model: CoreSessionModel
  let inFrame: Bool
  let clusters: [ScrubCluster]
  let total: CGFloat
  let scroll: TranscriptScrollModel
  let typography: TerminalTypography

  static let railWidth: CGFloat = 12
  static let hitWidth: CGFloat = 28

  var body: some View {
    GeometryReader { proxy in
      let railH = proxy.size.height
      ZStack(alignment: .topTrailing) {
        Canvas { context, size in
          for cluster in clusters where cluster.kind != "approval" { Self.draw(cluster, in: &context, width: size.width) }
        }
        .frame(width: Self.railWidth)
        .allowsHitTesting(false)
        if let approval = clusters.first(where: { $0.kind == "approval" }) {
          CoreApprovalMark(cluster: approval).frame(width: Self.railWidth).allowsHitTesting(false)
        }
        CoreRailBand(scroll: scroll, total: total, railH: railH)
          .frame(width: Self.railWidth)
          .allowsHitTesting(false)
        if let peek = model.ui.peek, peek.inFrame == inFrame {
          CorePeekPanel(peek: peek.peek, y: peek.y, railH: railH, available: proxy.size.width, typography: typography)
        }
        CoreRailTouch(model: model, inFrame: inFrame, clusters: clusters, total: total, railH: railH, scroll: scroll)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
      .onAppear { report(railH) }
      .onChange(of: railH) { _, height in report(height) }
    }
  }

  private func report(_ height: CGFloat) {
    guard height > 0 else { return }
    model.railSize(railH: Double(height), viewportH: Double(height), inFrame: inFrame)
  }

  private static func draw(_ cluster: ScrubCluster, in context: inout GraphicsContext, width: CGFloat) {
    let lane = width / 2
    let x = cluster.lane == "r" ? lane : 0
    let rect = CGRect(x: x, y: cluster.y, width: cluster.lane == "f" ? width : lane, height: cluster.h)
    func twoTone(_ tone: TermTone) {
      let color = TerminalPalette.color(tone)
      if rect.height > 2 {
        context.fill(
          Path(CGRect(x: rect.minX, y: rect.minY + 2, width: rect.width, height: rect.height - 2)),
          with: .color(color.opacity(0.25)))
      }
      context.fill(
        Path(CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: min(2, rect.height))), with: .color(color))
    }
    switch cluster.kind {
    case "user": twoTone(.blue)
    case "subagent": twoTone(.green)
    case "shell": twoTone(.magenta)
    case "turn": twoTone(.fg)
    case "turnFailed": twoTone(.red)
    case "error": context.fill(Path(rect), with: .color(TerminalPalette.color(.red)))
    case "toolFailed": context.fill(Path(rect), with: .color(TerminalPalette.color(.red).opacity(0.55)))
    case "bookmark": context.fill(Path(rect), with: .color(TerminalPalette.color(.magenta)))
    case "recap":
      var line = Path()
      let y = rect.midY.rounded()
      line.move(to: CGPoint(x: rect.minX, y: y))
      line.addLine(to: CGPoint(x: rect.maxX, y: y))
      context.stroke(line, with: .color(TerminalPalette.color(.faint)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
    default: break
    }
  }
}

private struct CoreApprovalMark: View {
  let cluster: ScrubCluster
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let bar = Rectangle()
      .fill(TerminalPalette.color(.yellow))
      .frame(height: cluster.h)
      .offset(y: cluster.y)
      .frame(maxHeight: .infinity, alignment: .top)
    if reduceMotion {
      bar
    } else {
      TimelineView(.periodic(from: .now, by: 0.6)) { context in
        bar.opacity(Int(context.date.timeIntervalSinceReferenceDate / 0.6) % 2 == 0 ? 1 : 0.3)
      }
    }
  }
}

// Its own view so a scroll tick redraws the band and nothing else.
private struct CoreRailBand: View {
  let scroll: TranscriptScrollModel
  let total: CGFloat
  let railH: CGFloat

  var body: some View {
    let band = scrubBand(
      railH: Double(railH), total: Double(total), viewportH: Double(scroll.viewportHeight),
      scrollOffset: Double(scroll.contentOffset))
    Rectangle()
      .fill(TerminalPalette.color(.faint).opacity(0.25))
      .overlay(Rectangle().stroke(TerminalPalette.color(.faint), lineWidth: 1))
      .frame(height: band.h)
      .offset(y: band.top)
      .frame(maxHeight: .infinity, alignment: .top)
  }
}

private struct CoreRailTouch: View {
  let model: CoreSessionModel
  let inFrame: Bool
  let clusters: [ScrubCluster]
  let total: CGFloat
  let railH: CGFloat
  let scroll: TranscriptScrollModel

  private static let slop: CGFloat = 3
  private static let pressSlop: Double = 8
  @State private var dragging = false
  @State private var peeked: (index: Int, y: Double)?

  var body: some View {
    Color.clear
      .frame(width: CoreScrubberRail.hitWidth)
      .contentShape(Rectangle())
      .gesture(gesture)
      .accessibilityElement()
      .accessibilityIdentifier("scrubber-rail")
      .accessibilityLabel("Transcript overview")
  }

  private var gesture: some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { value in
        if abs(value.translation.height) >= Self.slop { dragging = true }
        if dragging { scrub(value.location.y) }
        peek(at: value.location)
      }
      .onEnded { value in
        let wasDragging = dragging
        dragging = false
        peeked = nil
        model.peek(nil, y: 0, inFrame: inFrame)
        guard !wasDragging else { return }
        let cluster = hit(value.location).map { clusters[$0] }
        if let cluster, let row = scrubTarget(cluster: cluster, y: Double(value.location.y)) {
          scroll.scrollToRow(Int(row), anchor: .top, animated: true)
        } else if cluster?.kind == "approval" {
          scroll.scrollToBottom()
        } else {
          scrub(value.location.y)
        }
      }
  }

  private func hit(_ point: CGPoint) -> Int? {
    let x = point.x - (CoreScrubberRail.hitWidth - CoreScrubberRail.railWidth)
    return scrubHit(
      clusters: clusters, x: Double(x), y: Double(point.y), railW: Double(CoreScrubberRail.railWidth),
      slop: Self.pressSlop
    ).map(Int.init).flatMap { clusters.indices.contains($0) ? $0 : nil }
  }

  private func scrub(_ y: CGFloat) {
    guard railH > 0 else { return }
    let fraction = Double(min(1, max(0, y / railH)))
    scroll.scrollTo(
      contentOffset: CGFloat(scrubOffset(fraction: fraction, total: Double(total), viewportH: Double(railH))))
  }

  private func peek(at point: CGPoint) {
    guard let index = hit(point) else {
      if peeked != nil {
        peeked = nil
        model.peek(nil, y: 0, inFrame: inFrame)
      }
      return
    }
    let cluster = clusters[index]
    let y = min(max(Double(point.y), cluster.y), cluster.y + cluster.h)
    if let peeked, peeked.index == index, abs(peeked.y - y) < 2 { return }
    peeked = (index, y)
    model.peek(cluster, y: y, inFrame: inFrame)
  }
}

private struct CorePeekPanel: View {
  let peek: ScrubPeek
  let y: Double
  let railH: CGFloat
  let available: CGFloat
  let typography: TerminalTypography

  var body: some View {
    let lines = 1 + peek.lines.reduce(0) { $0 + ($1.excerpt ? 2 : 1) }
    let height = CGFloat(lines) * typography.line + 12
    VStack(alignment: .leading, spacing: 0) {
      Text(peek.title)
        .foregroundStyle(TerminalPalette.color(.faint))
        .frame(height: typography.line, alignment: .leading)
      ForEach(Array(peek.lines.enumerated()), id: \.offset) { _, line in
        (Text(line.glyph ?? "").foregroundStyle(TerminalPalette.color(.dim))
          + Text(line.text).foregroundStyle(TerminalPalette.color(TermTone(rawValue: line.tone) ?? .fg)))
          .lineLimit(line.excerpt ? 2 : 1)
      }
    }
    .font(typography.font)
    .multilineTextAlignment(.leading)
    .padding(6)
    .frame(width: min(260, max(120, available - CoreScrubberRail.railWidth - 24)), alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 4))
    .overlay(RoundedRectangle(cornerRadius: 4).stroke(TerminalPalette.color(.faint).opacity(0.4)))
    .padding(.trailing, CoreScrubberRail.railWidth + 4)
    .offset(y: max(4, min(railH - height - 4, CGFloat(y) - height / 2)))
    .allowsHitTesting(false)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("scrubber-peek")
  }
}
