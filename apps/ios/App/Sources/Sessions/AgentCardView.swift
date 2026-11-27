import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// A lead's fold control: the caret that expands its team and collapses it back to Auto.
struct TeamCaret {
  let open: Bool
  let toggle: () -> Void
}

// What a card does besides opening its session: its chips, its unfolded steps.
struct CardActions {
  var open: () -> Void
  var toggleChip: (StepFold) -> Void = { _ in }
  var openStep: (ListStep) -> Void = { _ in }
  var killStep: (ListStep) -> (() -> Void)? = { _ in nil }
}

// `SessionItem` from packages/ui, sized up for a finger: every row is one 44 line (6 padding, a 32 avatar), lead,
// Member and plain session alike. Name, model badge, then the status, which truncates first; right of the slack the step chips, the reason icons
// or a Member's unread count, and the team caret.
struct SessionCard: View {
  let item: ListItem
  var caret: TeamCaret?
  var hostName: String?
  var showsProject = true
  let actions: CardActions

  private var row: ListRow { item.row }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: actions.open) {
        head.contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      ForEach(row.steps) { step in
        SessionStepRow(step: step, indent: 40, onOpen: { actions.openStep(step) }, onKill: actions.killStep(step))
      }
    }
    .padding(6)
  }

  private var head: some View {
    HStack(spacing: 8) {
      AgentAvatarView(row: row, size: 32, context: row.depth == 0)
        .grayscale(quiet ? 1 : 0)
        .opacity(quiet ? 0.5 : 1)
        .accessibilityHidden(true)
      HStack(spacing: 6) {
        name
        if let badge = row.modelBadge, let label = row.modelLabel {
          ModelBadgeView(badge: badge, name: label, mark: row.mark, tinted: row.markTinted, size: 13)
        }
        if row.shared {
          Image(systemName: "globe")
            .font(.system(size: 10))
            .foregroundStyle(ListPalette.fg4)
            .accessibilityLabel("Shared with other owners")
        }
        status
          .font(ListType.label())
          .tracking(ListType.tracking * ListType.labelSize)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        StepChipsView(chips: row.chips, toggle: actions.toggleChip)
        if row.reasons.isEmpty {
          unread
          if row.pinned {
            Image(systemName: "pin.fill")
              .font(.system(size: 10))
              .foregroundStyle(ListPalette.fg3)
              .frame(width: 16, height: 16)
              .accessibilityLabel("Pinned")
          }
        } else {
          ReasonIconsView(reasons: row.reasons)
        }
        if let caret { CaretView(caret: caret, team: row.agent ?? "team", summary: row.teamSummary) }
      }
      .opacity(row.asleep ? 0.6 : 1)
    }
    .frame(height: 32)
  }

  // Nothing here for a person right now: the face greys out so the cards that do want attention stand out.
  private var quiet: Bool {
    let shown = row.teamState ?? row.state
    return !row.selected && !row.needsYou && row.unseen == 0 && (shown == .idle || shown == .ended)
  }

  @ViewBuilder
  private var name: some View {
    let text = Text(row.agent ?? row.title)
      .font(ListType.body(.medium))
      .tracking(ListType.tracking * ListType.bodySize)
      .lineLimit(1)
    if let agent = row.agent {
      text
        .foregroundStyle(ListPalette.name)
        .fixedSize()
        .accessibilityLabel(row.lead ? "\(agent), team lead" : agent)
    } else {
      text.foregroundStyle(ListPalette.fg1).layoutPriority(1)
    }
  }

  // An agent's own line; a plain session's status, project, gateway and age, giving way before its title does.
  private var status: some View {
    Group {
      if row.agent != nil {
        Text(row.cardStatus).foregroundStyle(row.cardStatusIsLabel ? ListPalette.fg3 : ListPalette.fg4)
      } else {
        Text(plainRun).foregroundStyle(ListPalette.fg4)
      }
    }
    .layoutPriority(-1)
  }

  private var plainRun: String {
    let project = showsProject ? row.project : row.projectSubpath
    let age = ago(epochMs: row.lastActivityAt, nowMs: Date().timeIntervalSince1970 * 1000)
    return [row.statusText, project, hostName, age == "just now" ? age : "\(age) ago"]
      .compactMap { $0?.isEmpty == false ? $0 : nil }
      .joined(separator: " \u{00B7} ")
  }

  // Plain accent text, on a Member only (a top-level agent is always relevant), once its turn has stopped.
  @ViewBuilder
  private var unread: some View {
    if row.depth > 0, item.unseen > 0, row.state != .working {
      Text(item.unseen > 99 ? "99+" : "\(item.unseen)")
        .font(ListType.label(.semibold))
        .monospacedDigit()
        .foregroundStyle(.tint)
        .frame(minWidth: 16, minHeight: 16)
        .accessibilityLabel("\(item.unseen) new message\(item.unseen == 1 ? "" : "s")")
    }
  }
}

// The lead's caret, in the column a group heading's chevron shares.
struct CaretView: View {
  let caret: TeamCaret
  let team: String
  let summary: String?

  var body: some View {
    Button(action: caret.toggle) {
      Image(systemName: caret.open ? "chevron.down" : "chevron.right")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(ListPalette.fg4)
        .frame(width: 20, height: 20)
        .contentShape(Rectangle())
        .hitPadding(8)
    }
    .buttonStyle(.borderless)
    .padding(.trailing, 2)
    .accessibilityLabel(caret.open ? "Show only active Team Members of \(team)" : "Show all Team Members of \(team)")
    .accessibilityHint(summary ?? "")
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

// `StepChips`: one icon per fold kind (the count is its label), tapped to show or hide that kind's steps under the card.
struct StepChipsView: View {
  let chips: [ListChip]
  let toggle: (StepFold) -> Void

  var body: some View {
    HStack(spacing: 2) {
      ForEach(chips, id: \.kind) { chip in
        Button {
          toggle(chip.kind)
        } label: {
          icon(chip.kind)
            .font(ListType.micro())
            .foregroundStyle(tone(chip))
            .frame(width: 16, height: 16)
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

// One icon per reason a card needs a person: shield (approval), hand (blocked), circled X (failed).
struct ReasonIconsView: View {
  let reasons: [ReasonChip]

  var body: some View {
    ForEach(reasons, id: \.label) { reason in
      Image(systemName: Self.symbol(reason))
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(reason.danger ? ListPalette.danger : ListPalette.warning)
        .frame(width: 16, height: 16)
        .accessibilityLabel(reason.label)
        .accessibilityHint(reason.title)
    }
  }

  private static func symbol(_ reason: ReasonChip) -> String {
    if reason.danger { return "xmark.circle" }
    return reason.label == "Blocked" ? "hand.raised" : "exclamationmark.shield"
  }
}

// What a row draws behind its card: a team's shared card while one of its rows is the selected one, the elbow tree
// line from the lead's avatar to each Member, and the attention tint on the row that needs a person itself.
struct CardBackground: View {
  let nest: NestRole?
  var needsYou = false
  var teamSelected = false
  static let edge: CGFloat = 8
  static let radius: CGFloat = 6
  // The lead's avatar spans 6 to 38 inside its card and a Member's starts at 30: the trunk runs under its left third.
  private static let trunk: CGFloat = edge + 15
  private static let indent: CGFloat = 24

  init(item: ListItem) {
    nest = item.nest
    needsYou = item.needsYou
    teamSelected = item.teamSelected
  }

  init(nest: NestRole?) {
    self.nest = nest
  }

  var body: some View {
    let insets = Self.insets(nest)
    ZStack(alignment: .topLeading) {
      if teamSelected { team }
      if needsYou {
        RoundedRectangle(cornerRadius: Self.radius).fill(ListPalette.attention).padding(insets)
      }
      tree
    }
  }

  @ViewBuilder
  private var team: some View {
    let edge = Self.edge
    let r = Self.radius
    switch nest {
    case .lead:
      UnevenRoundedRectangle(topLeadingRadius: r, topTrailingRadius: r).fill(ListPalette.nest)
        .padding(.top, 2).padding(.horizontal, edge)
    case .member:
      Rectangle().fill(ListPalette.nest).padding(.horizontal, edge)
    case .lastMember:
      UnevenRoundedRectangle(bottomLeadingRadius: r, bottomTrailingRadius: r).fill(ListPalette.nest)
        .padding(.bottom, 2).padding(.horizontal, edge)
    case nil:
      EmptyView()
    }
  }

  private var tree: some View {
    Canvas { ctx, size in
      let line = ListPalette.borderStrong
      switch nest {
      case .lead:
        ctx.fill(Path(CGRect(x: Self.trunk, y: 40, width: 2, height: max(0, size.height - 40))), with: .color(line))
      case .member, .lastMember:
        let mid: CGFloat = 4 + 22
        let bottom = nest == .lastMember ? mid + 1 : size.height
        ctx.fill(Path(CGRect(x: Self.trunk, y: 0, width: 2, height: bottom)), with: .color(line))
        ctx.fill(
          Path(CGRect(x: Self.trunk, y: mid - 1, width: Self.edge + Self.indent + 6 - Self.trunk, height: 2)),
          with: .color(line))
      case nil:
        break
      }
    }
    .accessibilityHidden(true)
  }

  static func insets(_ item: ListItem) -> EdgeInsets { insets(item.nest) }

  static func insets(_ nest: NestRole?) -> EdgeInsets {
    switch nest {
    case nil: return EdgeInsets(top: 2, leading: edge, bottom: 2, trailing: edge)
    case .lead: return EdgeInsets(top: 2, leading: edge, bottom: 0, trailing: edge)
    case .member: return EdgeInsets(top: 4, leading: edge + indent, bottom: 0, trailing: edge + 4)
    case .lastMember: return EdgeInsets(top: 4, leading: edge + indent, bottom: 6, trailing: edge + 4)
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
