import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// A lead's tray in Auto: the core already cut it to the pictures drawn and a `+n` overflow.
struct TeamTray {
  let row: ListRow
  let select: (TrayMember) -> Void
  let toggle: () -> Void

  var members: [TrayMember] { row.tray }
  var expanded: Bool { row.teamExpanded }
  var overflow: Int { Int(row.trayOverflow) }
}

// What a card does besides opening its session: its chips, its unfolded steps, its team tray.
struct CardActions {
  var open: () -> Void
  var toggleChip: (StepFold) -> Void = { _ in }
  var openStep: (ListStep) -> Void = { _ in }
  var killStep: (ListStep) -> (() -> Void)? = { _ in nil }
}

// `SessionItem` from packages/ui: the agent card (48 = 4 padding + 40 face), the Member card inside a team's shared card
// (one 28 row = 4 padding + 20 face), a plain session in the agent card's shape (`tile`), or the gutter row when no agent is listed.
struct SessionCard: View {
  static let edge: CGFloat = 8

  let item: ListItem
  var tray: TeamTray?
  var hostName: String?
  var showsProject = true
  var projectImage: UIImage?
  let actions: CardActions

  private var row: ListRow { item.row }
  private var member: Bool { row.depth > 0 && row.agent != nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: actions.open) {
        head.contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      ForEach(row.steps) { step in
        SessionStepRow(
          step: step, indent: member ? 28 : item.agentCard ? 48 : 22, onOpen: { actions.openStep(step) },
          onKill: actions.killStep(step))
      }
    }
    .padding(4)
  }

  @ViewBuilder
  private var head: some View {
    if member {
      memberHead
    } else if item.agentCard {
      cardHead
    } else {
      SessionRowView(
        row: row, hostName: hostName, unseen: item.unseen, projectImage: projectImage, showsProject: showsProject,
        chips: chips)
    }
  }

  private var cardHead: some View {
    HStack(spacing: 8) {
      AgentAvatarView(row: row, size: 40, context: row.agent != nil)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          name()
          if row.agent != nil { badge(size: 13) }
          if row.shared {
            Image(systemName: "globe")
              .font(.system(size: 10))
              .foregroundStyle(ListPalette.fg4)
              .accessibilityLabel("Shared with other owners")
          }
          Spacer(minLength: 0)
          ReasonChipsView(reasons: row.reasons)
          UnreadBadge(count: item.unseen, live: row.state == .working)
          if let tray { TrayView(tray: tray) }
          if row.agent == nil, let percentage = row.contextPercent {
            ContextRing(percentage: percentage, diameter: 14, lineWidth: 2, showsLabel: false)
          }
        }
        .frame(minHeight: 20)
        HStack(spacing: 6) {
          (row.agent != nil ? status : SessionRowView.details(
            row: row, hostName: hostName, showsProject: showsProject, projectImage: projectImage))
            .font(ListType.body())
            .tracking(ListType.tracking * 13)
            .foregroundStyle(ListPalette.fg4)
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 0)
          chips
        }
        .frame(minHeight: 20)
      }
      .opacity(row.asleep ? 0.6 : 1)
    }
  }

  // One 20 row: name (at most 60%, never the first to give way), badge, status (truncates), then unread and chips.
  private var memberHead: some View {
    HStack(spacing: 8) {
      AgentAvatarView(row: row, size: 20)
      HStack(spacing: 6) {
        MemberLine(spacing: 6) {
          name()
          badge(size: 12)
          status
            .font(ListType.label())
            .tracking(ListType.tracking * 12)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 0)
        ReasonChipsView(reasons: row.reasons)
        UnreadBadge(count: item.unseen, live: row.state == .working)
        chips
      }
      .frame(height: 20)
      .opacity(row.asleep ? 0.6 : 1)
    }
  }

  private func name() -> some View {
    let title = row.agent ?? row.title
    return Text(title)
      .font(ListType.body(.medium))
      .tracking(ListType.tracking * 13)
      .foregroundStyle(row.agent != nil ? ListPalette.name : ListPalette.fg1)
      .lineLimit(1)
      .layoutPriority(1)
      .accessibilityLabel(row.lead ? "\(title), team lead" : title)
  }

  @ViewBuilder
  private func badge(size: CGFloat) -> some View {
    if let badge = row.modelBadge, let name = row.modelLabel {
      ModelBadgeView(badge: badge, name: name, mark: row.mark, tinted: row.markTinted, size: size)
    }
  }

  private var status: Text {
    Text(row.cardStatus).foregroundStyle(row.cardStatusIsLabel ? ListPalette.fg3 : ListPalette.fg4)
  }

  private var chips: StepChipsView {
    StepChipsView(chips: row.chips, toggle: actions.toggleChip)
  }
}

// `ModelBadge`: the vendor mark, the model's letter and its version raised as a superscript, in the vendor colour.
struct ModelBadgeView: View {
  let badge: ModelBadge
  let name: String
  let mark: Mark?
  let tinted: Bool
  let size: CGFloat

  private var tone: Color {
    guard tinted, let mark else { return ListPalette.fg3 }
    return VendorPalette.color(mark)
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      EngineIconView(mark: mark, tinted: tinted, size: size)
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + size * 0.36 }
      HStack(alignment: .firstTextBaseline, spacing: 1) {
        Text(badge.letter).font(.system(size: size, weight: .medium))
        if let version = badge.version {
          Text(version)
            .font(.system(size: size * 0.7, weight: .medium))
            .offset(y: -size * 0.4)
        }
      }
      .monospacedDigit()
    }
    .foregroundStyle(tone)
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
  }
}

// The Member line's first three: the name takes what it needs up to 60% of the line, the badge its own width, and the
// status what is left.
struct MemberLine: Layout {
  var spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let frames = place(width: proposal.width, subviews: subviews)
    let height = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
    return CGSize(width: frames.map { $0.x + $0.width }.max() ?? 0, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (subview, frame) in zip(subviews, place(width: bounds.width, subviews: subviews)) {
      subview.place(
        at: CGPoint(x: bounds.minX + frame.x, y: bounds.midY), anchor: .leading,
        proposal: ProposedViewSize(width: frame.width, height: bounds.height))
    }
  }

  private func place(width: CGFloat?, subviews: Subviews) -> [(x: CGFloat, width: CGFloat)] {
    let available = width ?? .infinity
    var x: CGFloat = 0
    var out: [(x: CGFloat, width: CGFloat)] = []
    for (index, subview) in subviews.enumerated() {
      let ideal = subview.sizeThatFits(.unspecified).width
      let room = max(0, available - x)
      let cap = index == 0 ? min(room, available * 0.6) : room
      let used = min(ideal, cap)
      out.append((x, used))
      if used > 0 { x += used + spacing }
    }
    return out
  }
}

// `StepChips`: one chip per fold kind, tapped to show or hide that kind's steps under the card.
struct StepChipsView: View {
  let chips: [ListChip]
  let toggle: (StepFold) -> Void

  var body: some View {
    HStack(spacing: 2) {
      ForEach(chips, id: \.kind) { chip in
        Button {
          toggle(chip.kind)
        } label: {
          HStack(spacing: 4) {
            icon(chip.kind)
            Text("\(chip.count)").monospacedDigit()
          }
          .font(ListType.micro())
          .foregroundStyle(tone(chip))
          .padding(.horizontal, 4)
          .frame(height: 16)
          .background(RoundedRectangle(cornerRadius: 3).fill(chip.open ? ListPalette.chipOpen : Color.clear))
          .hitPadding()
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("\(chip.open ? "Hide" : "Show") \(chip.label)")
      }
    }
  }

  private func tone(_ chip: ListChip) -> Color {
    if chip.failed { return ListPalette.danger }
    if chip.kind == .shell { return ListPalette.shell }
    if chip.running > 0 { return chip.kind == .agent ? ListPalette.success : ListPalette.fg2 }
    return ListPalette.fg4
  }

  @ViewBuilder
  private func icon(_ kind: StepFold) -> some View {
    switch kind {
    case .shell: Text(TerminalShell.glyph).font(.system(size: 11, weight: .semibold, design: .monospaced))
    case .bash: Image(systemName: "apple.terminal").font(.system(size: 10))
    case .task: Image(systemName: "checklist").font(.system(size: 10))
    case .agent: LucideBot().stroke(style: LucideBot.stroke(11)).frame(width: 11, height: 11)
    }
  }
}

// One chip per reason the session needs a person: "Approval", "Failed", "Blocked".
struct ReasonChipsView: View {
  let reasons: [ReasonChip]

  var body: some View {
    ForEach(reasons, id: \.label) { reason in
      Text(reason.label)
        .font(ListType.micro())
        .foregroundStyle(reason.danger ? ListPalette.danger : ListPalette.warning)
        .padding(.horizontal, 4)
        .frame(height: 16)
        .background(
          RoundedRectangle(cornerRadius: 3)
            .fill(reason.danger ? ListPalette.dangerBackground : ListPalette.warningBackground)
        )
        .fixedSize()
        .accessibilityLabel(reason.title)
    }
  }
}

// Auto's tray on a lead: how many Members need a person, the rest as 16 pt faces, then `+n` or a chevron that expands
// the team; expanded, `^ n` returns it to Auto.
struct TrayView: View {
  let tray: TeamTray

  var body: some View {
    HStack(spacing: 4) {
      if tray.row.teamAttention > 0 {
        Text("\(tray.row.teamAttention)")
          .font(.system(size: 12))
          .monospacedDigit()
          .foregroundStyle(ListPalette.warning)
          .padding(.horizontal, 6)
          .frame(height: 16)
          .background(Capsule().fill(ListPalette.warningBackground))
          .accessibilityLabel(tray.row.teamSummary ?? "")
      }
      if !tray.expanded {
        ForEach(tray.members, id: \.key) { member in
          Button { tray.select(member) } label: {
            TrayAvatarView(member: member, size: 16).hitPadding()
          }
          .buttonStyle(.borderless)
          .accessibilityLabel("Open \(member.title)")
        }
      }
      Button(action: tray.toggle) {
        Group {
          if tray.expanded {
            HStack(spacing: 2) {
              Image(systemName: "chevron.up").font(.system(size: 9, weight: .semibold))
              Text("\(tray.row.members)").monospacedDigit()
            }
          } else if tray.overflow > 0 {
            Text("+\(tray.overflow)").monospacedDigit()
          } else {
            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
          }
        }
        .font(ListType.label())
        .foregroundStyle(tray.expanded ? ListPalette.fg3 : ListPalette.fg4)
        .padding(.horizontal, 2)
        .hitPadding()
      }
      .buttonStyle(.borderless)
      .accessibilityLabel(tray.expanded ? "Show only active Members" : "Show all Team Members")
    }
  }
}

// The card surfaces under a row: its own rounded card, or its slice of a team's shared card.
struct CardBackground: View {
  let item: ListItem
  private let edge = SessionCard.edge

  var body: some View {
    let fill: Color? = item.needsYou ? ListPalette.attention : nil
    switch item.nest {
    case nil:
      RoundedRectangle(cornerRadius: 8).fill(fill ?? .clear).padding(.vertical, 2).padding(.horizontal, edge)
    case .lead:
      ZStack {
        UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8).fill(ListPalette.nest)
        if let fill { RoundedRectangle(cornerRadius: 8).fill(fill) }
      }
      .padding(.top, 2)
      .padding(.horizontal, edge)
    case .member, .lastMember:
      let last = item.nest == .lastMember
      ZStack {
        UnevenRoundedRectangle(bottomLeadingRadius: last ? 8 : 0, bottomTrailingRadius: last ? 8 : 0)
          .fill(ListPalette.nest)
          .padding(.bottom, last ? 2 : 0)
        if let fill {
          RoundedRectangle(cornerRadius: 4).fill(fill)
            .padding(.top, 4)
            .padding(.bottom, last ? 6 : 0)
            .padding(.horizontal, 4)
        }
      }
      .padding(.horizontal, edge)
    }
  }

  static func insets(_ item: ListItem) -> EdgeInsets {
    let edge = SessionCard.edge
    switch item.nest {
    case nil: return EdgeInsets(top: 2, leading: edge, bottom: 2, trailing: edge)
    case .lead: return EdgeInsets(top: 2, leading: edge, bottom: 0, trailing: edge)
    case .member: return EdgeInsets(top: 4, leading: edge + 4, bottom: 0, trailing: edge + 4)
    case .lastMember: return EdgeInsets(top: 4, leading: edge + 4, bottom: 6, trailing: edge + 4)
    }
  }
}

struct UnreadBadge: View {
  let count: Int
  let live: Bool

  var body: some View {
    if count > 0 {
      Text("\(count)")
        .font(ListType.label().monospacedDigit())
        .foregroundStyle(live ? ListPalette.badgeForeground : Color.white)
        .padding(.horizontal, 8)
        .frame(minWidth: 24, minHeight: 16)
        .background(Capsule().fill(live ? AnyShapeStyle(ListPalette.badge) : AnyShapeStyle(.tint)))
        .accessibilityLabel("\(count) new messages")
    }
  }
}

// lucide `bot` (24 grid, stroke 2, round caps and joins): the sub-agent chip's glyph on the web, no SF Symbol draws it.
struct LucideBot: Shape {
  static func stroke(_ size: CGFloat) -> StrokeStyle {
    StrokeStyle(lineWidth: 2 * size / 24, lineCap: .round, lineJoin: .round)
  }

  func path(in rect: CGRect) -> Path {
    let k = min(rect.width, rect.height) / 24
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * k, y: rect.minY + y * k) }
    var path = Path()
    path.move(to: p(12, 8)); path.addLine(to: p(12, 4)); path.addLine(to: p(8, 4))
    path.addRoundedRect(in: CGRect(origin: p(4, 8), size: CGSize(width: 16 * k, height: 12 * k)),
      cornerSize: CGSize(width: 2 * k, height: 2 * k))
    path.move(to: p(2, 14)); path.addLine(to: p(4, 14))
    path.move(to: p(20, 14)); path.addLine(to: p(22, 14))
    path.move(to: p(15, 13)); path.addLine(to: p(15, 15))
    path.move(to: p(9, 13)); path.addLine(to: p(9, 15))
    return path
  }
}

extension View {
  func hitPadding(_ amount: CGFloat = 6) -> some View {
    padding(.vertical, amount).contentShape(Rectangle()).padding(.vertical, -amount)
  }
}
