import WorkerDeckKit
import SwiftUI

/// The iPad workspace's project tree, beside the transcript instead of over it.
///
/// Shown or not shown — there is no collapsed strip. The way back to it is the
/// Files button in the session's own header, which is where someone looks for
/// it, and a permanent 36pt gutter to hold one button was paying rent in the
/// column the transcript needs most.
struct SessionFilesRail: View {
  static let defaultWidth: Double = 280
  static let minWidth: Double = 200
  static let maxWidth: Double = 460

  let scope: HostFileScope
  let onOpenFile: (String) -> Void

  @Environment(AppSettings.self) private var settings
  /// The live drag value. Held here rather than written straight to settings so
  /// a drag is one `UserDefaults` write at the end instead of one per frame.
  @State private var dragWidth: Double?
  @State private var dragBase: Double?

  var body: some View {
    HStack(spacing: 0) {
      // No `NavigationStack` of its own: the rail draws its own directory
      // header and keeps its own path, so there is nothing left for one to do —
      // and a stack here is exactly what let a sub-folder escape into the split
      // view's detail pane. See `HostFilesBrowser`'s inline mode.
      HostFilesBrowser(scope: scope, onOpenFile: onOpenFile, inline: true)
        .frame(width: width)
      resizeHandle
    }
    .frame(maxHeight: .infinity)
  }

  private var width: Double {
    min(max(dragWidth ?? settings.filesRailWidth, Self.minWidth), Self.maxWidth)
  }

  private var resizeHandle: some View {
    Divider()
      .frame(width: 1)
      .overlay {
        Rectangle()
          .fill(.clear)
          .frame(width: 12)
          .contentShape(Rectangle())
          .gesture(
            DragGesture(minimumDistance: 1)
              .onChanged { value in
                let base = dragBase ?? settings.filesRailWidth
                dragBase = base
                dragWidth = base + value.translation.width
              }
              .onEnded { _ in
                settings.filesRailWidth = width
                dragWidth = nil
                dragBase = nil
              })
      }
      .accessibilityLabel("Resize the file rail")
  }
}
