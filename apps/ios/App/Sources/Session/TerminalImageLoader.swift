import SwiftUI
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

/// Fetches the pictures a tool result carried, one box at a time, as the reader
/// scrolls them into view.
///
/// The replay delivers those pictures as addresses rather than bytes - measured,
/// 91% of all tool-result payload was base64 that no client rendered - so the
/// bytes are paid for exactly once, by exactly the reader looking at them.
///
/// **The collection view is the visibility system.** A cell is told to load in
/// `willDisplay` and to cancel in `didEndDisplaying`; there is no second
/// observer, because a mounted row is by definition near the viewport and a
/// second answer to that question would only be able to disagree with the first.
///
/// Two pieces of state, and each earns its place:
///
/// - An `NSCache` of decoded images, so a scroll-back does not re-fetch and so
///   the system can evict under pressure without this having to guess a budget.
///   Decoded rather than raw: `UIImage(data:)` on 300 KB of PNG is not free, and
///   it would otherwise run on every appearance.
/// - A `failed` set, so a stale address (a dormant wake renumbers the log, and
///   the gateway 404s rather than serving another call's pixels) settles into
///   "image unavailable" instead of retrying on every pass.
@MainActor
final class TerminalImageLoader {
  // Set by the session view: a path under the REST base -> bytes. `host` names where a host-path picture is served.
  var fetch: (@Sendable (String) async throws -> Data)?
  var host: ((String) -> HostImageFetch?)?
  var sessionId = ""

  private let cache = NSCache<NSString, UIImage>()
  private var failed: Set<String> = []

  /// What the box should draw right now, without asking for anything.
  func state(for box: TermImageBox) -> TerminalImageState {
    if let image = cache.object(forKey: box.key as NSString) { return .loaded(image) }
    return failed.contains(box.key) ? .failed : .placeholder
  }

  /// Start a fetch for this box unless its answer is already known.
  ///
  /// Returns the task so the cell can cancel it when the row leaves the screen.
  /// `nil` means there is nothing to wait for - cached, already failed, or no
  /// fetcher wired (the preview harness, where nothing asked for refs).
  func load(_ box: TermImageBox, onSettle: @escaping (TerminalImageState) -> Void)
    -> Task<Void, Never>?
  {
    guard case .placeholder = state(for: box), let fetch else { return nil }
    let key = box.key
    let target = target(box)
    return Task { @MainActor [weak self] in
      var body: Data?
      if let target { body = try? await fetch(target.path) }
      guard !Task.isCancelled, let self else { return }
      let data = target?.fsRead == true ? body.flatMap { Self.fsImage($0, box.hostPath ?? "") } : body
      guard let data, let image = UIImage(data: data) else {
        // Undecodable is a failure like any other: the box says so and keeps
        // its size. It must never collapse - a row that changed height because
        // a network call failed is the reflow this whole design exists to
        // prevent.
        self.failed.insert(key)
        return onSettle(.failed)
      }
      self.cache.setObject(image, forKey: key as NSString)
      onSettle(.loaded(image))
    }
  }
}

extension TerminalImageLoader {
  private func target(_ box: TermImageBox) -> HostImageFetch? {
    guard let path = box.hostPath else {
      return HostImageFetch(
        path: resultImagePath(
          sessionId: sessionId, seq: Int64(box.sourceSeq), toolUseId: box.toolUseId, partIndex: Int64(box.partIndex)),
        fsRead: false)
    }
    return host?(path) ?? nil
  }

  private static func fsImage(_ body: Data, _ path: String) -> Data? {
    String(data: body, encoding: .utf8).flatMap { hostImageBase64(body: $0, path: path) }
      .flatMap { Data(base64Encoded: $0) }
  }
}

/// The three things a box can be showing. All the same height - see
/// `TermImage`.
enum TerminalImageState {
  case placeholder
  case loaded(UIImage)
  case failed
}

/// Reaches the row cells deep inside the transcript, for the same reason the
/// produced-image loader does. Absent outside a live session - a preview
/// harness has nothing to fetch from - and boxes then rest on their placeholder,
/// which is correct: nothing refs a replay nobody asked for.
private struct TerminalImageLoaderKey: EnvironmentKey {
  static let defaultValue: TerminalImageLoader? = nil
}

extension EnvironmentValues {
  var terminalImageLoader: TerminalImageLoader? {
    get { self[TerminalImageLoaderKey.self] }
    set { self[TerminalImageLoaderKey.self] = newValue }
  }
}
