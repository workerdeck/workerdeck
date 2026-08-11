import SwiftUI

/// Root: the unified session list over every configured gateway, or the host
/// manager when there are none yet. There is no "selected" gateway anymore —
/// the gateway is a facet of the one list, not the frame around it — so a push
/// naming any gateway is the list's to route, not ours to switch worlds for.
struct RootView: View {
  @Environment(HostStore.self) private var hosts
  @Environment(PushCoordinator.self) private var push

  var body: some View {
    Group {
      if hosts.hosts.isEmpty {
        NavigationStack {
          HostListView()
        }
      } else {
        SessionListView()
      }
    }
    // Registering is per gateway, so a newly added server picks up the token
    // without waiting for a relaunch.
    .task(id: hosts.hosts) { await push.syncRegistrations() }
  }
}
