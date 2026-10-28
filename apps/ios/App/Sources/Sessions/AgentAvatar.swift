import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// The no-avatar fallback: a native client draws no face until it has a face renderer.
struct AgentAvatarView: View {
  let row: ListRow
  var size: CGFloat = 32
  var state: RowState?
  var badge = true

  private var shown: RowState { state ?? row.state }
  private var asleep: Bool { row.asleep }
  private var corner: CGFloat { size >= 28 ? 14 : 11 }

  var body: some View {
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
    RoundedRectangle(cornerRadius: 4)
      .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
      .foregroundStyle(.tertiary)
      .frame(width: size, height: size)
    .accessibilityLabel(member.title)
  }
}
