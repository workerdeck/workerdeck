import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The session screen's lesser facts, read when the chrome or the transcript moves.
struct CoreSessionExtras: Equatable, Sendable {
  // Items since the read mark, while the recap seam stands.
  var newRows: Int?
  var canSleep = false
  var cwd: String?
  var mismatch: Int?
}

// What a row offers beyond a press, set once by the session screen for its transcript and its sub-agent screens.
struct CoreRowActions {
  var menu: (Int, _ inFrame: Bool) -> TerminalRowMenu?
  var openImage: (UIImage) -> Void
}

extension EnvironmentValues {
  @Entry var coreRowActions: CoreRowActions?
}

struct CoreRowExtras: ViewModifier {
  let actions: CoreRowActions
  @Binding var viewing: CoreViewedImage?
  let revision: Int
  let onBookmarks: () -> Void

  func body(content: Content) -> some View {
    content
      .environment(\.coreRowActions, actions)
      .fullScreenCover(item: $viewing) { CoreImageViewer(viewed: $0) }
      .onChange(of: revision) { onBookmarks() }
  }
}

// The long-press menu on a row: the core says what the row offers, the reader's bookmarks say which label it wears.
@MainActor
enum CoreRowMenu {
  static func make(
    model: CoreSessionModel, bookmarks: BookmarkModel?, hostId: UUID, sessionId: String
  ) -> (Int, Bool) -> TerminalRowMenu? {
    { row, inFrame in
      guard let menu = model.rowMenu(row: row, inFrame: inFrame) else { return nil }
      let bookmark = menu.bookmarkItemId.flatMap { id in
        bookmarks.map { store in
          TerminalRowMenu.Bookmark(
            active: store.bookmarks(host: hostId, sessionId: sessionId).contains(id),
            toggle: {
              store.toggle(host: hostId, sessionId: sessionId, itemId: id)
              model.setBookmarks(store.bookmarks(host: hostId, sessionId: sessionId))
            })
        }
      }
      let background = menu.backgroundCallId.map { id in { model.backgroundTask(id) } }
      return TerminalRowMenu(bookmark: bookmark, copyText: menu.copyText, background: background)
    }
  }
}

// "N new rows since you were last here", above the composer: the seam is in the transcript, this is the way back.
struct CoreCatchUpBar: View {
  let count: Int
  let onJump: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Text(TermGlyph.recap)
      Text("\(count) new \(count == 1 ? "row" : "rows") since you were last here")
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("jump", action: onJump)
        .buttonStyle(.plain)
        .foregroundStyle(Color.accentColor)
      Button("dismiss", action: onDismiss)
        .buttonStyle(.plain)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    .padding(.horizontal, 8)
    .padding(.top, 6)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("catch-up-bar")
  }
}

// What a session shows before it has said anything. It sheds its parts as the height shrinks (icon, then path, then
// everything), and promises only what this composer does today.
struct CoreEmptyState: View {
  let cwd: String?
  let canRunShell: Bool

  var body: some View {
    GeometryReader { proxy in
      let height = proxy.size.height
      if height >= 130 {
        VStack(spacing: 18) {
          if height >= 320 {
            Image(systemName: "terminal")
              .font(.system(size: 24, weight: .light))
              .foregroundStyle(.secondary)
              .frame(width: 58, height: 58)
              .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
          }
          if height >= 230, let cwd {
            Text(cwd)
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(.head)
              .padding(.horizontal, 24)
          }
          VStack(spacing: 0) {
            ForEach(Array(hints.enumerated()), id: \.offset) { index, hint in
              if index > 0 { Divider().padding(.leading, 46) }
              HStack(spacing: 12) {
                Image(systemName: hint.symbol).frame(width: 22)
                Text(hint.text).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
              }
              .font(.footnote)
              .foregroundStyle(.secondary)
              .padding(.horizontal, 14)
              .padding(.vertical, 10)
            }
          }
          .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
          .padding(.horizontal, 20)
        }
        .frame(width: proxy.size.width, height: height)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("empty-state")
      }
    }
    .allowsHitTesting(false)
  }

  private var hints: [(symbol: String, text: String)] {
    var hints = [(symbol: "text.bubble", text: "Tell me what to do")]
    if canRunShell { hints.append((symbol: "dollarsign", text: "Type $ to run a command on the host.")) }
    return hints
  }
}

// The protocol notices: a version mismatch stays, a protocol error can be dismissed.
struct CoreWarnings: View {
  let mismatch: Int?
  let error: String?
  let onDismiss: () -> Void

  var body: some View {
    VStack(spacing: 4) {
      if let mismatch {
        strip(
          "Server speaks protocol v\(mismatch), this app mirrors v\(WorkerProtocol.version). Some events may not render.",
          dismiss: nil)
      }
      if let error { strip(error, dismiss: onDismiss) }
    }
  }

  private func strip(_ text: String, dismiss: (() -> Void)?) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
      Text(text).frame(maxWidth: .infinity, alignment: .leading)
      if let dismiss {
        Button("Dismiss", systemImage: "xmark", action: dismiss)
          .labelStyle(.iconOnly)
          .buttonStyle(.borderless)
      }
    }
    .font(.caption)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(Color.orange.opacity(0.12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("session-warning")
  }
}

struct CoreViewedImage: Identifiable {
  let id = UUID()
  let image: UIImage
}

// A tool result's picture, full screen: pinch or double-tap to zoom, share, close.
struct CoreImageViewer: View {
  let viewed: CoreViewedImage
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var settled: CGFloat = 1

  var body: some View {
    NavigationStack {
      Image(uiImage: viewed.image)
        .resizable()
        .scaledToFit()
        .scaleEffect(scale)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
        .gesture(
          MagnifyGesture()
            .onChanged { scale = max(1, settled * $0.magnification) }
            .onEnded { _ in settled = scale })
        .onTapGesture(count: 2) {
          withAnimation {
            scale = scale > 1 ? 1 : 2.5
            settled = scale
          }
        }
        .accessibilityIdentifier("image-viewer")
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button("Done") { dismiss() }
          }
          ToolbarItem(placement: .topBarTrailing) {
            ShareLink(item: Image(uiImage: viewed.image), preview: SharePreview("Image", image: Image(uiImage: viewed.image)))
          }
        }
        .toolbarBackground(.visible, for: .navigationBar)
    }
  }
}
