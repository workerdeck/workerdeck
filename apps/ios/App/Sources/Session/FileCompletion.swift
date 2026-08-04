import WorkerDeckKit
import Foundation
import Observation

/// Drives the `@file` suggestion list under the composer. The text half —
/// finding and replacing the token — is `FileToken` in `WorkerDeckKit`, where it
/// can be unit-tested; this is the part that needs a client and a clock.
///
/// Searches are debounced and single-flight: every keystroke cancels the pending
/// one, so a fast typist makes one request, not eight. A server without host files
/// answers 404 once and completion switches itself off for the rest of the session
/// rather than asking again on every character.
@MainActor
@Observable
final class FileCompletionModel {
  private(set) var matches: [HostFileMatch] = []
  /// True while a token is active — the composer shows the list only then.
  private(set) var isActive = false

  private let scope: HostFileScope
  private var task: Task<Void, Never>?
  private var unsupported = false
  private var lastQuery: String?

  /// Enough rows to be useful, few enough to leave the transcript visible.
  private static let limit = 8
  private static let debounceNanoseconds: UInt64 = 150_000_000

  init(scope: HostFileScope) {
    self.scope = scope
  }

  /// Call on every draft change.
  func update(for text: String) {
    guard !unsupported, let query = FileToken.query(in: text) else {
      cancel()
      return
    }
    guard query != lastQuery else { return }
    lastQuery = query
    isActive = true
    task?.cancel()
    task = Task { [scope] in
      try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
      guard !Task.isCancelled else { return }
      do {
        let response = try await scope.client.findHostFiles(
          in: scope.cwd, matching: query, limit: Self.limit)
        guard !Task.isCancelled else { return }
        matches = response.matches
      } catch let error as WorkerClientError where error.statusCode == 404 {
        // No host files on this gateway (or the cwd isn't under a root). Stop
        // asking — the answer will not change while this session is open.
        unsupported = true
        cancel()
      } catch {
        // A failed lookup shows no suggestions; it is not worth an error banner
        // over an affordance the user can ignore.
        matches = []
      }
    }
  }

  /// Insert a chosen path and close the list.
  func accept(_ match: HostFileMatch, in text: String) -> String {
    let next = FileToken.apply(match.relative, to: text)
    cancel()
    return next
  }

  func cancel() {
    task?.cancel()
    task = nil
    lastQuery = nil
    matches = []
    isActive = false
  }
}
