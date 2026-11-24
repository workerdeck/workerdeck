import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

// An agent draws its face; a plain session draws its engine's mark on a solid vendor ground that fills from the bottom
// with its context use (amber from the wrap-up threshold on), its status badge top right where a face draws its state.
struct AgentAvatarView: View {
  let row: ListRow
  var size: CGFloat = 32
  var state: RowState?
  var badge = true
  var context = false

  private static let wrapUp = 0.4

  private var shown: RowState { state ?? row.state }
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
      .overlay(alignment: .topTrailing) {
        if badge, shown != .idle || row.asleep {
          SessionStatusIcon(row: row, state: shown)
            .font(.system(size: corner * 0.7))
            .frame(width: corner, height: corner)
            .background(Circle().fill(Color(.systemBackground)))
            .offset(x: 4, y: -4)
        }
      }
      .accessibilityLabel(row.agent ?? "Session")
  }

  private var picture: some View {
    let vendor = row.markTinted ? row.mark.map(VendorPalette.color) ?? ListPalette.fg4 : ListPalette.fg4
    let level = context ? min(1, max(0, (row.contextPercent ?? 0) / 100)) : 0
    return ZStack(alignment: .bottom) {
      Rectangle().fill(vendor.opacity(0.24))
      if level > 0 {
        GeometryReader { box in
          VStack(spacing: 0) {
            Spacer(minLength: 0)
            ZStack {
              if level >= Self.wrapUp {
                Rectangle().fill(ListPalette.amber.opacity(0.45))
              } else {
                Rectangle().fill(Color(.systemBackground))
                Rectangle().fill(vendor.opacity(0.48))
              }
            }
            .frame(height: box.size.height * level)
          }
        }
      }
      EngineIconView(mark: row.mark, tinted: row.markTinted, size: size / 2)
        .frame(maxHeight: .infinity)
    }
    .background(Color(.systemBackground))
    .clipShape(RoundedRectangle(cornerRadius: 4))
  }
}
