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
  /// One unread memory for the whole process — the session screen writes marks
  /// into it, the list and the app icon badge count from it.
  @State private var unread = UnreadModel()

  init() {
    // Debug-only, and silent unless InjectionNext is set up — see HotReload.swift.
    HotReload.start()
  }

  var body: some Scene {
    WindowGroup {
      // Set UIPREVIEW to render one screen from canned data instead of the app —
      // see UIPreviewHarness. Absent (always, outside a simulator check) this is
      // one environment lookup at launch.
      if let preview = UIPreview.active {
        UIPreviewHarness(variant: preview)
      } else {
        RootView()
          .environment(hosts)
          .environment(unread)
          .environment(delegate.push)
          // The delegate is built by UIKit before any of this exists, so the two
          // are introduced here rather than at either one's construction.
          .task { delegate.push.attach(hosts: hosts) }
      }
    }
  }
}
