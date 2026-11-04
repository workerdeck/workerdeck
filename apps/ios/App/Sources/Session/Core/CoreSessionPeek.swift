import SwiftUI
import WorkerDeckKit

// The long-press preview over a session card: the live transcript, read-only, its newest rows in view. It never marks
// the session read and closes its socket when the menu goes.
struct CoreSessionPeek: View {
  @State private var model: CoreSessionModel
  @State private var scroll = TranscriptScrollModel()
  @State private var images = TerminalImageLoader()
  private let title: String
  private let hideThinking: Bool
  private let sessionId: String
  private let client: WorkerClient

  init(sessionId: String, client: WorkerClient, title: String, hideThinking: Bool) {
    self.sessionId = sessionId
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
    .onDisappear { model.close() }
  }

  private static var width: CGFloat {
    (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width.advanced(by: -32) ?? 360
  }
}
