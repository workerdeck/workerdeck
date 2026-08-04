import SwiftUI

/// App entry.
///
/// One `HostStore` for the whole process (the Keychain-backed list of gateways),
/// and a root that either shows the host manager or scopes everything below it to
/// the selected host.
@main
struct WorkerDeckApp: App {
  @State private var hosts = HostStore()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(hosts)
    }
  }
}
