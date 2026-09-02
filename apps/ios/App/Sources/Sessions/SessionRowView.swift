import WorkerDeckKit
import SwiftUI

/// One live session. Title falls back to the working directory's leaf, which is
/// what the session is "about" before the agent has said anything.
/// Internal rather than private so `UIPreviewHarness` can render it against
/// canned data: every project state below (bytes in, bytes not in, a glyph this
/// build cannot map, no project at all) needs a differently-configured gateway
/// to reach in the real app.
struct SessionRowView: View {
  let session: SessionInfo
  /// Named only when more than one gateway is in the list (and the grouping
  /// isn't already saying it).
  var hostName: String?
  /// Transcript rows since this session was last on screen; 0 renders nothing.
  var unseen: Int = 0
  /// Resolved bytes for an `image` project icon, if this project has one and the
  /// loader has fetched it. Nil draws no picture — the name is already there.
  ///
  /// **Must already be glyph-boxed** (`UIImage.fittedToProjectGlyphBox()`, which
  /// `ProjectIconLoader` applies on the way in). This is drawn as a character
  /// inside a `Text` run, and a `Text` has no `.frame` to constrain a picture
  /// with — an unresized logo sets the line height to whatever the repo checked
  /// in. The size cannot be enforced here without paying a resize per row per
  /// poll, so it is a contract, stated here and honoured by both callers.
  var projectImage: UIImage?
  /// False when the list is already grouped by project: the section header has
  /// said the name, so the slot carries the **sub-path inside the project**
  /// instead (`projectSubpath`) — the one thing the header cannot say. A session
  /// at the project root has nothing to add and the slot disappears. The rule
  /// `hostName` follows one facet over.
  var showsProject: Bool = true
  var expanded: Bool = false

  static let verticalPadding: CGFloat = 3

  /// Two lines, in the order the dashboard's row uses
  /// (`packages/ui`'s `SessionBrowser`): what you scan the list by on top, what
  /// it *is* underneath. The same person reads all three clients, so the
  /// segments and their order are not this client's to choose — only how they
  /// are drawn is (a touch-sized row, SF Symbols, `Fmt.ago`).
  ///
  /// State leads both lines, in a gutter the engine's mark lands in underneath.
  /// It used to trail, and a trailing glyph has no fixed x — it sits wherever
  /// the age and the ring leave it, so a list of thirty gives the eye nothing to
  /// run down. Leading, every row's state stacks into one strip.
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        // The gutter: a fixed cell rather than a bare glyph, so the status above
        // and the engine mark below start at the same x however wide either
        // draws — and so the two text columns agree.
        SessionStatusIcon(session: session)
          .frame(width: 16)
          .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
        Text(title)
          .font(.body.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 0)
        if unseen > 0 {
          // **The colour is the state's, not the count's** — see
          // `ListPalette.badge`. Live: the tint, because unread is a call to
          // look. Settled: the neutral badge, because the same number is then
          // only a record of what you missed.
          let live = sessionState(session) == .working || sessionState(session) == .attention
          Text("\(unseen)")
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(live ? Color.white : ListPalette.badgeForeground)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(live ? AnyShapeStyle(.tint) : AnyShapeStyle(ListPalette.badge)))
            .accessibilityLabel("\(unseen) new messages")
        }
        // How full the window is, at a glance and across the whole list — the
        // question you cannot ask from inside a session. Absent draws nothing:
        // an empty ring would claim an empty context where there is simply no
        // reading (see `SessionInfo.contextUsage`).
        if let context = session.contextUsage {
          ContextRing(
            percentage: context.percentage, diameter: 14, lineWidth: 2, showsLabel: false)
            // The ring sits with the caption text, not with the title's cap
            // height — baseline alignment would hang a circle off the row.
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
        }
      }
      // Line two: one truncating run, in one order, so the list reads the same
      // on a phone as it does in a sidebar. A `Text` concatenation rather than
      // an `HStack` of pieces, and that is the point: the parts have a priority
      // order and a single ellipsis honours it, where stack children would each
      // shrink a little and leave four half-words.
      HStack(spacing: 0) {
        // The engine's mark, in the vendor's colour, under the status glyph and
        // in the same cell. Absent engines draw nothing — the cell keeps the
        // column, so a mark-less row still lines up with its neighbours.
        //
        // **16, not 11.** The mark used to be drawn at the view's own 11pt
        // default inside a 14pt cell, which is the *same bug* the Figma frame
        // had and revised out: transparent inner padding leaving the glyph too
        // small for the text it labels. This is one of the two places the
        // design's pixels are taken literally rather than translated into
        // Dynamic Type — a glyph cell is a column, and a column that breathes
        // with the text size stops being one.
        EngineIconView(
          engine: session.engine?.rawValue ?? "claude", model: session.model, size: 16
        )
        .frame(width: 16)
        .padding(.trailing, 8)
        // The project glyph is NOT here. It rides *inside* the run below,
        // immediately before the name it labels — see `projectIconText`. Held
        // out here it sat between the engine mark and the model, which is
        // nothing's icon: the reading was `✳ 🗇 Opus 5 · WorkerDeck`, a picture
        // of the project introducing a model.
        detailsText
          .font(.caption)
          .lineLimit(1)
          // Tail truncation: everything on this line leads with the fact that
          // identifies it, and the sub-path form (`packages/ui`) is read from
          // the front. The old head-truncated raw cwd is gone with the path.
          .truncationMode(.tail)
        // **The age is not in the run**, and it is on this line rather than
        // beside the title — both the way the dashboard draws it, and the way
        // the frame does. At the end of the run it was the first thing an
        // ellipsis ate, which is backwards: `4m` is two characters answering
        // "is this still moving", where a truncated project name still says
        // which repo. Its own atom, and the run yields to it.
        if let activity = session.lastActivityAt {
          Text(" · " + Fmt.ago(epochMs: activity))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .layoutPriority(1)
        }
        Spacer(minLength: 6)
        let steps = sessionSteps(session)
        if !steps.isEmpty {
          // `.hidden()` keeps the layout: the disclosure `SessionCardView` overlays as a button is this same view, so its width is reserved here and never measured.
          StepDisclosure(expanded: expanded, running: runningSteps(steps), total: steps.count)
            .hidden()
        }
        // Same trick for the overflow control the card overlays: reserved here,
        // never measured there, so the identity run truncates before it reaches
        // it instead of sliding underneath.
        SessionOverflowGlyph().hidden()
      }
    }
    .padding(.vertical, Self.verticalPadding)
  }

  private var title: String {
    if let title = session.title, !title.isEmpty { return title }
    return Fmt.lastComponent(session.cwd)
  }

  /// The project slot: the declared name, or — under a project group — where in
  /// the project this session sits. Nil when there is nothing left to say.
  private var project: String? {
    showsProject ? projectLabel(session) : projectSubpath(session)
  }

  /// Line two, joined the way the dashboard joins it: model, project, gateway,
  /// profile, cost. Nothing empty ever reaches the join, so a missing part
  /// closes up rather than leaving ` ·  · ` behind.
  ///
  /// A `Text` concatenation rather than a `String`, because the model wears the
  /// vendor's colour and the rest does not — and one `Text` built from two is
  /// still one truncating run, which a stack of two would not be.
  private var detailsText: Text {
    // The shared rule, ported into the kit: a model spelled `claude-opus-5` here
    // and `Opus 5` in the sidebar is the same drift the shared list view model
    // exists to prevent.
    var parts: [Text] = []
    // The model as a person says it — `claude-opus-5[1m]` is a wire value, and
    // a card line has no room for a context-window suffix.
    if let model = friendlyModel(session.model) {
      parts.append(Text(model).foregroundStyle(modelTint))
    }
    if let project {
      // Glyph then name, as one part: they are one reading, so they clip
      // together rather than the picture holding a slot its text already lost.
      parts.append((projectIconText ?? Text("")) + Text(project).foregroundStyle(.secondary))
    }
    for extra in [
      hostName,
      session.profile.map { "@\($0)" },
      // `TermFmt.cost`, not `Fmt.cost`: the kit's is the port of the web's
      // `formatCost` ($3.10, and `<$0.01` rather than a fourth decimal), and a
      // list row is exactly where the same person compares the three clients.
      // `Fmt.cost` keeps its four decimals where a *single turn* is priced.
      (session.totalCostUsd ?? 0) > 0 ? TermFmt.cost(session.totalCostUsd) : nil,
    ].compactMap({ $0 }) {
      parts.append(Text(extra).foregroundStyle(.secondary))
    }
    // Separators live BETWEEN parts and are never attached to one. Attached, a
    // part that turned out absent left its separator behind — which is what a
    // session with no model recorded yet did: the line opened with a `· `
    // hanging off nothing.
    return parts.enumerated().reduce(Text("")) { joined, part in
      part.offset == 0 ? joined + part.element : joined + Text(" · ") + part.element
    }
  }

  /// The project's own glyph, as a **character in the identity run** rather than
  /// a view beside it — which is the whole reason it is a `Text` and not a
  /// `View`. Inline, it truncates with the name it labels; held out as its own
  /// cell it kept a slot on a line the name had already been squeezed off.
  ///
  /// A trailing hair space rather than a stack gap, for the same reason: a gap
  /// belongs to a layout, and there is no layout here — this is typography.
  ///
  /// Nil when there is nothing to draw, and **nil is not a placeholder**: an
  /// image whose bytes have not landed (or that Apple cannot decode — see
  /// `ProjectIconLoader` on SVG) contributes nothing, because the project's
  /// name is already right there and a box that becomes a picture a beat later
  /// is more movement than the picture is worth.
  private var projectIconText: Text? {
    guard showsProject, let icon = session.project?.icon else { return nil }
    switch icon {
    case .glyph(let name):
      return Text(Image(systemName: projectSymbol(forLucideName: name)))
        .foregroundStyle(.secondary) + Text("\u{2005}")
    case .image:
      // Already scaled to the 16pt box at fetch time: a `Text` has no `.frame`
      // to constrain a picture with. See `ProjectIconLoader`.
      guard let projectImage else { return nil }
      return Text(Image(uiImage: projectImage)) + Text("\u{2005}")
    }
  }

  /// The model name's colour: the vendor's, but only where the vendor's own
  /// guidance allows it past the mark — see `EngineMark.tintsName`, and the note
  /// there on what a full-contrast name does to the title above it.
  private var modelTint: Color {
    guard let mark = engineMark(engine: session.engine?.rawValue ?? "claude", model: session.model),
      mark.tintsName
    else { return .secondary }
    return VendorPalette.color(mark)
  }
}
