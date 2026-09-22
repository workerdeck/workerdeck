import SwiftUI

/// What a `$` row's two presses reach for, threaded the way the tool-result
/// fetcher is and for the same reason: the press lives several layers down
/// inside a transcript and a closure per row type would be worse than one value.
///
/// **The defaults do nothing**, which is correct wherever there is no live
/// session - the preview harness, a hand-composed row - since there is no
/// gateway there to expand or to kill against.
typealias ShellOutputFetcher = @MainActor (String) -> Void
typealias ShellKiller = @MainActor (String) -> Void
/// Open a shell's live terminal. Absent wherever there is no navigation stack
/// to push onto, and the row's press then falls back to the inline expansion.
typealias ShellOpener = @MainActor (String) -> Void

private struct ShellOutputFetcherKey: EnvironmentKey {
  static let defaultValue: ShellOutputFetcher? = nil
}

private struct ShellKillerKey: EnvironmentKey {
  static let defaultValue: ShellKiller? = nil
}

private struct ShellOpenerKey: EnvironmentKey {
  static let defaultValue: ShellOpener? = nil
}

extension EnvironmentValues {
  var shellOutputFetcher: ShellOutputFetcher? {
    get { self[ShellOutputFetcherKey.self] }
    set { self[ShellOutputFetcherKey.self] = newValue }
  }

  var shellKiller: ShellKiller? {
    get { self[ShellKillerKey.self] }
    set { self[ShellKillerKey.self] = newValue }
  }

  var shellOpener: ShellOpener? {
    get { self[ShellOpenerKey.self] }
    set { self[ShellOpenerKey.self] = newValue }
  }
}
