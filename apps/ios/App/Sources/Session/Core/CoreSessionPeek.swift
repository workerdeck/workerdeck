import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The long-press preview over a session card: the live transcript, read-only, its newest rows in view. What it shows
// counts as read, as on the session screen; it closes its socket when the menu goes.
struct CoreSessionPeek: View {
  @State private var model: CoreSessionModel
  @State private var scroll = TranscriptScrollModel()
  @State private var images = TerminalImageLoader()
  private let title: String
  private let hideThinking: Bool
  private let sessionId: String
  private let client: WorkerClient
  private let hostId: UUID
  private let unread: UnreadModel

  init(sessionId: String, hostId: UUID, client: WorkerClient, unread: UnreadModel, title: String, hideThinking: Bool) {
    self.sessionId = sessionId
    self.hostId = hostId
    self.unread = unread
    self.client = client
    self.title = title
    self.hideThinking = hideThinking
    _model = State(
      initialValue: CoreSessionModel(sessionId: sessionId, baseURL: client.baseURL.absoluteString, authKey: client.authKey))
  }

  var body: some View {
    VStack(spacing: 0) {
      Text(model.ui.title ?? title)
        .font(ListType.body(.medium))
        .foregroundStyle(ListPalette.fg1)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
      Divider()
      CoreTranscriptView(model: model, scroll: scroll, imageLoader: images, hideThinking: hideThinking)
        .overlay {
          if model.ui.main.rows.isEmpty { ProgressView() }
        }
        .allowsHitTesting(false)
    }
    .frame(width: Self.width, height: 460)
    .background(Color(.systemBackground))
    .onAppear {
      images.sessionId = sessionId
      images.host = { [model] in model.hostImage($0) }
      images.fetch = { [client] in try await client.bytes(path: $0) }
    }
    .onChange(of: model.ui.seen) { _, seen in if let seen { mark(seen) } }
    .onDisappear {
      finalizeSeen()
      model.close()
    }
  }

  private func mark(_ seen: SeenCounts) {
    guard model.ui.misplaced == nil else { return }
    unread.mark(
      host: hostId, sessionId: sessionId, itemCount: Int(seen.itemCount), conversation: seen.conversation.map(Int.init),
      activity: seen.activity.map(Int.init), prose: seen.prose.map(Int.init))
  }

  private func finalizeSeen() {
    guard model.ui.misplaced == nil, let seen = model.ui.seen else { return }
    Task { @MainActor [unread, hostId, sessionId, client] in
      let answer = await client.answer(getSessionCall(id: sessionId))
      guard answer.status == 200 else { return }
      unread.markSession(
        host: hostId, sessionId: sessionId, itemCount: Int(seen.itemCount), conversation: seen.conversation.map(Int.init),
        body: answer.body)
    }
  }

  private static var width: CGFloat {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width.advanced(by: -32) ?? 360
  }
}
