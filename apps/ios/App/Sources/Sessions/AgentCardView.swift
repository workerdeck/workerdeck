import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// A lead's tray in Auto: the core already cut it to the pictures drawn and a `+n` overflow.
struct TeamTray {
  let row: ListRow
  let members: [(member: TrayMember, info: SessionInfo)]
  let frames: (TrayMember, SessionInfo) -> AgentAvatarFrames?
  let select: (TrayMember) -> Void
  let toggle: () -> Void

  var expanded: Bool { row.teamExpanded }
  var overflow: Int { Int(row.trayOverflow) }
}

struct AgentCardView<MenuContent: View>: View {
  static func insets(member: Bool, hasSteps: Bool) -> EdgeInsets {
    member
      ? EdgeInsets(top: 4, leading: 44, bottom: 4, trailing: 16)
      : EdgeInsets(top: 8, leading: 12, bottom: hasSteps ? 2 : 8, trailing: 16)
  }

  let item: ListItem
  let frames: AgentAvatarFrames?
  var member = false
  var badgeState: SessionState?
  var teamUnseen = 0
  var tray: TeamTray?
  let onOpen: () -> Void
  @ViewBuilder var menu: () -> MenuContent

  private var info: SessionInfo { item.info }
  private var agent: AgentRef? { info.agent }
  private var status: String? { statusLine(info.statusLabel) }
  private var time: String? { info.lastActivityAt.map { Fmt.ago(epochMs: $0) } }

  var body: some View {
    Button(action: onOpen) {
      Group {
        if member { memberRow } else { card }
      }
      .foregroundStyle(.primary)
      .opacity(info.engineAsleep == true ? 0.6 : 1)
      .contentShape(Rectangle())
    }
    .overlay(alignment: member ? .trailing : .bottomTrailing) { controls }
  }

  private var card: some View {
    HStack(alignment: .center, spacing: 10) {
      AgentAvatarView(info: info, frames: frames, size: 44, state: badgeState)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          name
          if agent?.isLead == true { LeadChip() }
          if agent?.shared == true {
            Image(systemName: "globe")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .accessibilityLabel("Shared with other owners")
          }
          if let time {
            Text(time).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
          }
          Spacer(minLength: 0)
          UnreadBadge(count: item.unseen, live: item.live)
          if teamUnseen > 0 {
            Label("\(teamUnseen)", systemImage: "person.2.fill")
              .labelStyle(.titleAndIcon)
              .font(.caption2.weight(.semibold).monospacedDigit())
              .foregroundStyle(.white)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(Capsule().fill(.tint))
              .accessibilityLabel("\(teamUnseen) new messages in the team")
          }
          if let context = info.contextUsage {
            ContextRing(percentage: context.percentage, diameter: 14, lineWidth: 2, showsLabel: false)
          }
        }
        HStack(spacing: 0) {
          detailText.font(.caption).lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 6)
          controlsPlaceholder.hidden()
        }
      }
    }
    .padding(.vertical, 2)
  }

  private var memberRow: some View {
    HStack(spacing: 8) {
      AgentAvatarView(info: info, frames: frames, size: 32)
      name
      if let status {
        Text(status).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer(minLength: 0)
      UnreadBadge(count: item.unseen, live: item.live)
      if let time {
        Text(time).font(.caption).foregroundStyle(.secondary).lineLimit(1)
      }
      SessionOverflowGlyph().hidden()
    }
  }

  private var name: some View {
    Text(agent?.name ?? sessionLabel(info))
      .font(member ? .subheadline.weight(.medium) : .body.weight(.medium))
      .lineLimit(1)
      .layoutPriority(1)
  }

  private var detailText: Text {
    var parts: [Text] = []
    if let model = friendlyModel(info.model) {
      parts.append(Text(model).foregroundStyle(modelTint(info)))
    }
    if let status { parts.append(Text(status).foregroundStyle(.secondary)) }
    return parts.enumerated().reduce(Text("")) { joined, part in
      part.offset == 0 ? joined + part.element : joined + Text(" · ").foregroundStyle(.secondary) + part.element
    }
  }

  private var controls: some View {
    HStack(spacing: 0) {
      if let tray { trayButton(tray) }
      Menu {
        menu()
      } label: {
        SessionOverflowGlyph()
          .padding(.vertical, member ? 8 : 0)
          .padding(.bottom, member ? 0 : 4)
          .contentShape(Rectangle())
      }
      .tint(Color.secondary)
      .accessibilityLabel("Agent actions")
    }
  }

  private var controlsPlaceholder: some View {
    HStack(spacing: 0) {
      if let tray { trayLabel(tray) }
      SessionOverflowGlyph()
    }
  }

  private func trayButton(_ tray: TeamTray) -> some View {
    HStack(spacing: 4) {
      ForEach(tray.members, id: \.member.key) { entry in
        Button { tray.select(entry.member) } label: {
          AgentAvatarView(info: entry.info, frames: tray.frames(entry.member, entry.info), size: 18, badge: false)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Open \(entry.member.title)")
      }
      Button(action: tray.toggle) {
        trayGlyph(tray).padding(.vertical, 4).contentShape(Rectangle())
      }
      .buttonStyle(.borderless)
      .accessibilityLabel(tray.expanded ? "Show only active Members" : "Show all Team Members")
    }
    .padding(.leading, 10)
    .padding(.bottom, 4)
  }

  private func trayLabel(_ tray: TeamTray) -> some View {
    HStack(spacing: 4) {
      ForEach(tray.members, id: \.member.key) { entry in
        AgentAvatarView(info: entry.info, frames: tray.frames(entry.member, entry.info), size: 18, badge: false)
      }
      trayGlyph(tray)
    }
    .padding(.leading, 10)
  }

  @ViewBuilder
  private func trayGlyph(_ tray: TeamTray) -> some View {
    Group {
      if tray.overflow > 0 && !tray.expanded {
        Text("+\(tray.overflow)").monospacedDigit()
      } else {
        Image(systemName: tray.expanded ? "chevron.down" : "chevron.right")
          .font(.caption2.weight(.semibold))
      }
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }
}

struct UnreadBadge: View {
  let count: Int
  let live: Bool

  var body: some View {
    if count > 0 {
      Text("\(count)")
        .font(.caption2.weight(.semibold).monospacedDigit())
        .foregroundStyle(live ? Color.white : ListPalette.badgeForeground)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(live ? AnyShapeStyle(.tint) : AnyShapeStyle(ListPalette.badge)))
        .accessibilityLabel("\(count) new messages")
    }
  }
}

struct TeamTreeLine: View {
  var body: some View {
    HStack(spacing: 0) {
      Rectangle().fill(Color.secondary.opacity(0.35)).frame(width: 1)
        .padding(.leading, 33.5)
      Spacer(minLength: 0)
    }
  }
}

func modelTint(_ info: SessionInfo) -> Color {
  guard let mark = engineMark(engine: info.engine?.rawValue ?? "claude", model: info.model),
    mark.tintsName
  else { return .secondary }
  return VendorPalette.color(mark)
}

enum ListAttention {
  static var background: Color { Color.orange.opacity(0.12) }
}
