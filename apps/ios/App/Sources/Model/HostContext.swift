import WorkerDeckKit
import Foundation
import Observation

/// Everything scoped to one gateway: its client and its per-host preferences.
///
/// Rebuilt wholesale when the selected host changes (`RootView` keys the subtree
/// on the host id) — there is no migration path between two different servers.
@MainActor
@Observable
final class HostContext {
  let host: Host
  let client: WorkerClient
  /// Directories recently used to start a session here, most recent first.
  /// Offered as chips on the create form so nobody types a long path twice.
  private(set) var recentCwds: [String]

  private static let recentCwdCap = 8
  /// A URL that will never resolve, for a host whose address failed to parse.
  /// Every call then fails with a normal `WorkerClientError` instead of the app
  /// needing a second "unconfigured" state.
  private static let invalidBase = URL(string: "http://invalid.invalid/v1")

  private let defaults: UserDefaults

  init(host: Host, defaults: UserDefaults = .standard) {
    self.host = host
    self.defaults = defaults
    client =
      host.makeClient()
      ?? WorkerClient(baseURL: Self.invalidBase ?? URL(fileURLWithPath: "/"))
    recentCwds = defaults.stringArray(forKey: Self.recentKey(host.id)) ?? []
  }

  /// Promote a directory to the front of the recents, capped.
  func rememberCwd(_ cwd: String) {
    let trimmed = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    var next = recentCwds.filter { $0 != trimmed }
    next.insert(trimmed, at: 0)
    if next.count > Self.recentCwdCap { next = Array(next.prefix(Self.recentCwdCap)) }
    recentCwds = next
    defaults.set(next, forKey: Self.recentKey(host.id))
  }

  private nonisolated static func recentKey(_ id: UUID) -> String {
    "bi.atomic.workerdeck.ios.recentCwds.\(id.uuidString)"
  }
}
