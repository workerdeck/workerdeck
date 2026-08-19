import SwiftUI

/// How a row asks for the rest of a tool result whose replay delivered only its
/// head — the phone's mirror of `packages/ui`'s `ToolResultFetchProvider`.
///
/// An environment value for the reason the file downloader is one: the press
/// lives several layers down inside a transcript, in *two* renderers, and
/// threading a closure through every row type to reach it is worse than one
/// value. **The default does nothing**, which is correct wherever nothing asked
/// for heads — a preview harness, a hand-composed row — since a replay nobody
/// truncated has nothing to fetch.
///
/// Fire-and-forget by design: the answer is not returned to the presser, it is
/// hydrated into transcript state, so the row re-renders with the marker gone
/// and every other reader of that item sees the whole thing too.
typealias ToolResultFetcher = @MainActor (String) -> Void

private struct ToolResultFetcherKey: EnvironmentKey {
  static let defaultValue: ToolResultFetcher? = nil
}

extension EnvironmentValues {
  var toolResultFetcher: ToolResultFetcher? {
    get { self[ToolResultFetcherKey.self] }
    set { self[ToolResultFetcherKey.self] = newValue }
  }
}
