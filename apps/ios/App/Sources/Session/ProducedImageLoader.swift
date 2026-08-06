import WorkerDeckKit
import SwiftUI
import UIKit

/// Fetches pictures the ENGINE produced on the host, for the transcript.
///
/// Codex's `image_gen` reports a path and never bytes, so a tool card holding a
/// `savedPath` has nothing to show on its own. `file_produced` turns that path
/// into a `fileId` the gateway will serve — with no host-file root to declare
/// and no byte cap to raise, because the allowlist is the exact set of paths
/// this session's own runner reported writing.
///
/// Same two reasons for going through the client as `AttachmentLoader`: the
/// gateway authenticates with a header (an `AsyncImage` at the URL would 401),
/// and a `LazyVStack` would otherwise re-fetch on every scroll-back.
@MainActor
@Observable
final class ProducedImageLoader {
  /// Set by the session view: (fileId) -> bytes.
  var fetch: (@Sendable (String) async throws -> Data)?
  /// The session's `file_produced` announcements, keyed by host path — which is
  /// what a tool card has. Kept here rather than threaded through the transcript
  /// so `ToolCallCard` needs no new props.
  var files: [String: ProducedFile] = [:]

  private var images: [String: UIImage] = [:]
  private var inFlight: Set<String> = []

  func image(forPath path: String) -> UIImage? {
    guard let file = files[path] else { return nil }
    return images[file.fileId]
  }

  /// Whether this path is one the engine announced producing. False for a file
  /// the agent merely read — those are not produced files and stay behind
  /// `/fs/*` and its roots.
  func hasImage(forPath path: String) -> Bool {
    guard let file = files[path] else { return false }
    return file.mediaType?.hasPrefix("image/") ?? false
  }

  func load(path: String) {
    guard let file = files[path], hasImage(forPath: path) else { return }
    let id = file.fileId
    guard images[id] == nil, !inFlight.contains(id), let fetch else { return }
    inFlight.insert(id)
    Task {
      defer { inFlight.remove(id) }
      // A failure is left as "no image": the card still shows the path, which is
      // the honest rendering for a file that has since moved or been deleted.
      guard let data = try? await fetch(id), let image = UIImage(data: data) else { return }
      images[id] = image
    }
  }
}

/// Reaches a tool card deep inside the transcript, for the same reason
/// `attachmentLoader` does. Absent outside a live session, and generated images
/// then render as the path alone.
private struct ProducedImageLoaderKey: EnvironmentKey {
  static let defaultValue: ProducedImageLoader? = nil
}

extension EnvironmentValues {
  var producedImageLoader: ProducedImageLoader? {
    get { self[ProducedImageLoaderKey.self] }
    set { self[ProducedImageLoaderKey.self] = newValue }
  }
}
