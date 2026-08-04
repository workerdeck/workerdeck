import SwiftUI

/// App entry.
///
/// One `HostStore` for the whole process (the Keychain-backed list of gateways),
/// one `PushCoordinator` (owned by the delegate, because APNs only answers
/// there), and a root that either shows the host manager or scopes everything
/// below it to the selected host.
@main
struct WorkerDeckApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var hosts = HostStore()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(hosts)
        .environment(delegate.push)
        // The delegate is built by UIKit before any of this exists, so the two
        // are introduced here rather than at either one's construction.
        .task { delegate.push.attach(hosts: hosts) }
    }
  }
}
