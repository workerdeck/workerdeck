import WorkerDeckKit
import Foundation
import Observation

/// Loads the two lists behind the session screen: live sessions from the server's
/// registry, and the Agent SDK's on-disk sessions (for resume across restarts).
///
/// Both refreshes swallow nothing — a failed load leaves the previous rows on
/// screen and surfaces the server's own message, because on a tailnet the usual
/// failure is "VPN dropped", not "the data is gone".
@MainActor
@Observable
final class SessionListModel {
  enum Tab: String, CaseIterable, Identifiable {
    case live
    case resume

    var id: String { rawValue }
    var label: String { self == .live ? "Live" : "Resume" }
  }

  var tab: Tab = .live
  private(set) var sessions: [SessionInfo] = []
  private(set) var sdkSessions: [SdkSessionSummary] = []
  private(set) var errorMessage: String?
  private(set) var isLoading = false
  private(set) var hasLoaded = false

  private let client: WorkerClient

  init(client: WorkerClient) {
    self.client = client
  }

  func refresh() async {
    isLoading = true
    defer {
      isLoading = false
      hasLoaded = true
    }
    do {
      let loaded = try await client.listSessions()
      // Most recently active first; a session that never emitted an event sorts
      // by creation instead of falling to the bottom.
      sessions = loaded.sorted {
        ($0.lastActivityAt ?? $0.createdAt) > ($1.lastActivityAt ?? $1.createdAt)
      }
      errorMessage = nil
    } catch {
      errorMessage = Self.describe(error)
    }
  }

  func refreshSdkSessions() async {
    do {
      sdkSessions = try await client.listSdkSessions(limit: 50)
      errorMessage = nil
    } catch {
      errorMessage = Self.describe(error)
    }
  }

  /// Refresh whichever tab is showing (pull-to-refresh, foreground, post-create).
  func refreshCurrentTab() async {
    switch tab {
    case .live: await refresh()
    case .resume: await refreshSdkSessions()
    }
  }

  func close(_ session: SessionInfo) async {
    do {
      try await client.deleteSession(id: session.id)
      await refresh()
    } catch {
      errorMessage = Self.describe(error)
    }
  }

  static func describe(_ error: any Error) -> String {
    if let workerError = error as? WorkerClientError { return workerError.message }
    if let urlError = error as? URLError { return urlError.localizedDescription }
    return error.localizedDescription
  }
}
