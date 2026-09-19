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
  /// One unread memory for the whole process - the session screen writes marks
  /// into it, the list and the app icon badge count from it.
  @State private var unread = UnreadModel()
  /// The reader's bookmarks - one map for every gateway, the session screen
  /// toggles into it and the rail draws from it.
  @State private var bookmarks = BookmarkModel()

  init() {
    // Debug-only, and silent unless InjectionNext is set up - see HotReload.swift.
    HotReload.start()
  }

  var body: some Scene {
    WindowGroup {
      // Set UIPREVIEW to render one screen from canned data instead of the app -
      // see UIPreviewHarness. Absent (always, outside a simulator check) this is
      // one environment lookup at launch.
      if let preview = UIPreview.active {
        UIPreviewHarness(variant: preview)
      } else {
        RootView()
          .environment(delegate.hosts)
          .environment(unread)
          // The delegate's instance, not a second one: it is also what the Live Activity intent
          // handler and the two push coordinators read, and two copies would drift the moment a
          // toggle moved.
          .environment(delegate.settings)
          .environment(bookmarks)
          .environment(delegate.push)
          .environment(delegate.activities)
          // Both coordinators are attached in `didFinishLaunching`, not here: a background launch
          // has no scene and would otherwise never register a token or answer a card's button.
          .task { await delegate.activities.reconcile() }
          .onOpenURL { delegate.push.handle(url: $0) }
      }
    }
  }
}
