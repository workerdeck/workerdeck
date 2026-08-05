import SwiftUI

/// Hot reload, in about forty lines and with no package dependency.
///
/// The mechanism is [InjectionNext](https://github.com/johnno1962/InjectionNext):
/// a Mac app watches the sources, recompiles the one file you edited into a
/// dylib, codesigns it and sends it to the running app, which loads it. Because
/// Debug builds link with `-interposable` (see `project.yml`), loading that dylib
/// *replaces* the function implementations rather than adding new ones — so the
/// running app starts executing the code you just wrote, with its navigation
/// stack and state intact.
///
/// Two deliberate choices here:
///
/// - **No Swift package.** InjectionNext ships prebuilt bundles and a copy
///   script, which `project.yml`'s `--hot` build phase uses. The app's rule of
///   zero third-party Swift dependencies survives; what it loads in Debug is a
///   bundle, not a linked library, and release builds compile this file to
///   nothing.
/// - **`@HotReloaded` on the views you are iterating on**, which is the same
///   shape as the `Inject` package's `@ObserveInjection` and is that way for a
///   reason: an observer at the *root* is not enough. Injection replaces the
///   implementations, but SwiftUI only re-runs a `body` whose inputs changed —
///   a parent redrawing hands its child the same struct value it had before, and
///   the child is skipped. The subscription has to live in the view that should
///   re-render. (Measured, not assumed: a root-only observer logged "Rebound 5
///   symbols" and left the old pixels on screen.)
///
///   The alternative — `.id()` on the root, forcing a full rebuild — works
///   without annotations and throws away every `@State` and the navigation
///   stack, which is the one thing hot reload is for.
///
/// What it cannot do: add or remove stored properties, change a function's
/// signature, or introduce a new file. Those need a real build — `deploy.sh`.
enum HotReload {
  /// Load the injection bundle, if this build has one. Call once at launch.
  ///
  /// The bundle is looked for inside the app first (that is where the copy phase
  /// puts it, and the only place a *device* can find it), then in the Mac's
  /// `/Applications` — which works on the Simulator, since it shares the host
  /// filesystem, and means a simulator run needs no `--hot` build at all.
  static func start() {
    #if DEBUG
      let candidates = [
        Bundle.main.path(forResource: "iOSInjection", ofType: "bundle"),
        "/Applications/InjectionNext.app/Contents/Resources/iOSInjection.bundle",
      ]
      for path in candidates.compactMap({ $0 }) where FileManager.default.fileExists(atPath: path) {
        Bundle(path: path)?.load()
        return
      }
    #endif
  }
}

#if DEBUG
  /// Publishes whenever an injection lands, so an observing view re-renders.
  @MainActor
  final class InjectionObserver: ObservableObject {
    static let shared = InjectionObserver()

    private init() {
      NotificationCenter.default.addObserver(
        forName: Notification.Name("INJECTION_BUNDLE_NOTIFICATION"), object: nil,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.objectWillChange.send() }
      }
    }
  }

#endif

/// Declare a view hot-reloadable: `@HotReloaded private var hot`.
///
/// It must be a stored property of the view struct rather than a modifier on it.
/// SwiftUI re-runs a `body` when one of that view's own `DynamicProperty`
/// dependencies changes; a modifier wrapping the view is downstream of its body
/// and cannot make it run again.
///
/// Cheap enough to leave on: in release it holds nothing and the property is a
/// constant `true`. Add it to whatever you are working on; nothing breaks if a
/// view doesn't have it, that view just needs a rebuild to show a change.
@MainActor
@propertyWrapper
struct HotReloaded: DynamicProperty {
  #if DEBUG
    @ObservedObject private var observer = InjectionObserver.shared
  #endif

  var wrappedValue: Bool { true }
}
