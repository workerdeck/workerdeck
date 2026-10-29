import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// An agent draws its face; a plain session draws its engine's mark in the same tile, with the status badge a face
// would otherwise carry in its pose.
struct AgentAvatarView: View {
  let row: ListRow
  var size: CGFloat = 32
  var state: RowState?
  var badge = true
  var context = false

  private var shown: RowState { state ?? row.state }
  private var asleep: Bool { row.asleep }
  private var corner: CGFloat { size >= 28 ? 14 : 11 }

  var body: some View {
    if let face = row.face {
      FaceView(spec: face, size: size, context: context)
        .accessibilityLabel(row.agent ?? "Agent")
    } else {
      tile
    }
  }

  private var tile: some View {
    picture
      .frame(width: size, height: size)
      .overlay(alignment: .bottomTrailing) {
        if badge, shown != .idle || asleep {
          SessionStatusIcon(row: row, state: shown)
            .font(.system(size: corner * 0.7))
            .frame(width: corner, height: corner)
            .background(Circle().fill(Color(.systemBackground)))
            .offset(x: 4, y: 4)
        }
      }
      .accessibilityLabel(row.agent ?? "Session")
  }

  private var picture: some View {
    RoundedRectangle(cornerRadius: 4)
      .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
      .foregroundStyle(.tertiary)
      .overlay {
        EngineIconView(mark: row.mark, tinted: row.markTinted, size: size / 2)
      }
  }
}

struct LeadChip: View {
  var body: some View {
    Text("LEAD")
      .font(.system(size: 9, weight: .semibold))
      .tracking(0.6)
      .foregroundStyle(.tint)
      .padding(.horizontal, 4)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(.tint.opacity(0.5), lineWidth: 1))
  }
}

// A tray picture: idle by definition (Auto shows every busy Member as a row), so no badge.
struct TrayAvatarView: View {
  let member: TrayMember
  var size: CGFloat = 18

  var body: some View {
    Group {
      if let face = member.face {
        FaceView(spec: face, size: size)
      } else {
        RoundedRectangle(cornerRadius: 4)
          .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
          .foregroundStyle(.tertiary)
          .frame(width: size, height: size)
      }
    }
    .accessibilityLabel(member.title)
  }
}
