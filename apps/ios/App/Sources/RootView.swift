import SwiftUI

/// Root: the selected host's session list, or the host manager when there is no
/// selection yet.
struct RootView: View {
  @Environment(HostStore.self) private var hosts
  @Environment(PushCoordinator.self) private var push

  var body: some View {
    Group {
      if let host = hosts.selectedHost {
        HostScope(host: host)
          // A different host is a different world — client, sessions, recents.
          // Keying on the id rebuilds the whole subtree instead of migrating it.
          .id(host.id)
      } else {
        NavigationStack {
          HostListView()
        }
      }
    }
    // A push names the gateway that sent it, which need not be the one on
    // screen. Selecting it here rebuilds the subtree; `SessionListView` then
    // consumes the same route when it appears, so neither has to know which of
    // the two ran first. `.task(id:)` rather than `.onChange` because a cold
    // launch from a notification sets the route before this view exists.
    .task(id: push.pendingRoute) { selectRoutedHost() }
    // Registering is per gateway, so a newly added server picks up the token
    // without waiting for a relaunch.
    .task(id: hosts.hosts) { await push.syncRegistrations() }
  }

  private func selectRoutedHost() {
    guard let id = push.pendingRoute?.hostId, id != hosts.selectedHostID,
      hosts.hosts.contains(where: { $0.id == id })
    else { return }
    hosts.select(id)
  }
}

/// Owns the `HostContext` for one gateway and hands it to everything below.
private struct HostScope: View {
  @State private var context: HostContext

  init(host: Host) {
    _context = State(initialValue: HostContext(host: host))
  }

  var body: some View {
    SessionListView()
      .environment(context)
  }
}
