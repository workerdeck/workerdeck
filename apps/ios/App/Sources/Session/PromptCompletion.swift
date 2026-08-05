import WorkerDeckKit
import Foundation
import Observation

/// Drives the suggestion list under the composer, for both prompt tokens.
///
/// The text half — finding and replacing a token — is `PromptTokens` in
/// `WorkerDeckKit`, where it can be unit-tested; this is the part that needs a
/// client, a clock, and the session's capabilities.
///
/// The two halves behave nothing alike, which is why they share a model rather
/// than a code path. `/commands` arrive with the `capabilities` event, so
/// filtering them is local, synchronous and complete. `@files` are a search
/// against the host filesystem: debounced and single-flight, so a fast typist
/// makes one request rather than eight, and a gateway without host files answers
/// 404 once and file completion switches itself off for the session rather than
/// asking again on every character.
@MainActor
@Observable
final class PromptCompletionModel {
  enum Suggestion: Identifiable, Equatable {
    case file(HostFileMatch)
    case command(SlashCommandInfo)

    var id: String {
      switch self {
      case .file(let match): return "@\(match.relative)"
      case .command(let command): return "/\(command.name)"
      }
    }

    /// What replaces the token — without its prefix, which `PromptTokens` adds.
    var value: String {
      switch self {
      case .file(let match): return match.relative
      case .command(let command): return command.name
      }
    }
  }

  private(set) var suggestions: [Suggestion] = []
  /// True while a token is active — the composer shows the list only then.
  private(set) var isActive = false

  /// Slash commands from `capabilities`; empty until that event lands.
  var commands: [SlashCommandInfo] = []
  /// Host-file search, absent until the session's cwd is known.
  var scope: HostFileScope? {
    didSet {
      guard scope?.cwd != oldValue?.cwd else { return }
      // A resume into a different directory invalidates both the results and
      // the verdict on whether this gateway serves host files at all.
      filesUnsupported = false
      cancel()
    }
  }

  /// Whether `@file` completion is on offer: the session's cwd is known and this
  /// gateway hasn't already 404'd the search. Read by the empty state, which must
  /// not advertise a feature this server doesn't serve.
  var hasFileSearch: Bool { scope != nil && !filesUnsupported }

  private var task: Task<Void, Never>?
  private var filesUnsupported = false
  private var lastQuery: String?

  /// Enough rows to be useful, few enough to leave the transcript visible.
  private static let limit = 8
  private static let debounceNanoseconds: UInt64 = 150_000_000

  /// Call on every edit, with the caret the edit left behind.
  func update(for text: String, cursor: String.Index?) {
    guard let token = PromptTokens.active(in: text, at: cursor ?? text.endIndex) else {
      cancel()
      return
    }
    switch token.kind {
    case .command: showCommands(matching: token.query)
    case .file: searchFiles(matching: token.query)
    }
  }

  /// Insert a chosen suggestion and close the list. The token is re-read from the
  /// current draft rather than remembered: the text may have moved on since the
  /// list was built, and replacing a stale range would corrupt the message.
  func accept(_ suggestion: Suggestion, in text: String, cursor: String.Index?)
    -> (text: String, cursor: String.Index)
  {
    let caret = cursor ?? text.endIndex
    defer { cancel() }
    guard let token = PromptTokens.active(in: text, at: caret) else { return (text, caret) }
    return PromptTokens.apply(suggestion.value, replacing: token, in: text)
  }

  func cancel() {
    task?.cancel()
    task = nil
    lastQuery = nil
    suggestions = []
    isActive = false
  }

  // MARK: - The two halves

  /// Local and immediate. Matches on the command name, its aliases, and the bare
  /// name of a namespaced one — typing "wrapup" should find "dev:wrapup".
  private func showCommands(matching query: String) {
    task?.cancel()
    task = nil
    lastQuery = nil
    isActive = true
    let needle = query.lowercased()
    suggestions =
      commands
      .filter { needle.isEmpty || $0.matches(prefix: needle) }
      .prefix(20)
      .map(Suggestion.command)
  }

  private func searchFiles(matching query: String) {
    guard !filesUnsupported, let scope else {
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
        suggestions = response.matches.map(Suggestion.file)
      } catch let error as WorkerClientError where error.statusCode == 404 {
        // No host files on this gateway (or the cwd isn't under a root). Stop
        // asking — the answer will not change while this session is open.
        filesUnsupported = true
        cancel()
      } catch {
        // A failed lookup shows no suggestions; it is not worth an error banner
        // over an affordance the user can ignore.
        suggestions = []
      }
    }
  }
}

extension SlashCommandInfo {
  fileprivate func matches(prefix needle: String) -> Bool {
    let candidates = [name] + (aliases ?? []) + name.split(separator: ":").map(String.init)
    return candidates.contains { $0.lowercased().hasPrefix(needle) }
  }
}
