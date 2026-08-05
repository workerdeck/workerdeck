import WorkerDeckKit
import SwiftUI
import UIKit

/// Fetches attachment bytes for the transcript, once each.
///
/// The gateway authenticates with a header, so an `AsyncImage` pointed at the
/// URL would 401 — every thumbnail goes through the client. The cache is what
/// keeps a `LazyVStack` from re-fetching a photo each time its row scrolls back
/// into view.
@MainActor
@Observable
final class AttachmentLoader {
  /// Set by the session view: (attachmentId) -> bytes.
  var fetch: (@Sendable (String) async throws -> Data)?

  private var images: [String: UIImage] = [:]
  private var inFlight: Set<String> = []

  func image(for id: String) -> UIImage? { images[id] }

  func load(_ id: String) {
    guard images[id] == nil, !inFlight.contains(id), let fetch else { return }
    inFlight.insert(id)
    Task {
      defer { inFlight.remove(id) }
      // A failure is left as "no image": the row falls back to the named chip,
      // which is the honest rendering for an attachment the server no longer has
      // (its store is the session's lifetime, not forever).
      guard let data = try? await fetch(id), let image = UIImage(data: data) else { return }
      images[id] = image
    }
  }
}

/// Reaches the user bubble deep inside the transcript, for the same reason
/// `fileDownloader` does. Absent outside a live session, and attachments then
/// render as chips without thumbnails.
private struct AttachmentLoaderKey: EnvironmentKey {
  static let defaultValue: AttachmentLoader? = nil
}

extension EnvironmentValues {
  var attachmentLoader: AttachmentLoader? {
    get { self[AttachmentLoaderKey.self] }
    set { self[AttachmentLoaderKey.self] = newValue }
  }
}

/// What a sent message's attachments look like in the transcript: a row of
/// thumbnails for images, named chips for everything else.
struct SentAttachmentsView: View {
  let attachments: [MessageAttachment]

  @Environment(\.attachmentLoader) private var loader

  var body: some View {
    HStack(spacing: 6) {
      ForEach(attachments) { attachment in
        if attachment.isImage {
          thumbnail(attachment)
        } else {
          chip(attachment)
        }
      }
    }
  }

  private func thumbnail(_ attachment: MessageAttachment) -> some View {
    Group {
      if let image = loader?.image(for: attachment.id) {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      } else {
        RoundedRectangle(cornerRadius: 10)
          .fill(Color.secondary.opacity(0.16))
          .overlay(Image(systemName: "photo").font(.footnote).foregroundStyle(.secondary))
      }
    }
    .frame(width: 84, height: 84)
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .task(id: attachment.id) { loader?.load(attachment.id) }
    .accessibilityLabel(attachment.name)
  }

  private func chip(_ attachment: MessageAttachment) -> some View {
    HStack(spacing: 5) {
      Image(systemName: "doc")
      Text(attachment.name)
        .lineLimit(1)
        .truncationMode(.middle)
      Text(Fmt.bytes(attachment.bytes))
        .foregroundStyle(.secondary)
    }
    .font(.caption)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(Color.secondary.opacity(0.16), in: Capsule())
  }
}
