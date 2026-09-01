import Foundation
import WorkerDeckKit

/// Last known per-profile usage, kept outside any view model so a session
/// switch does not blank it.
///
/// Usage belongs to the *account*, not the session, but it is fetched by the
/// session screen's view model — which is created per session. Without this,
/// opening another session on the same profile would drop the authoritative
/// reading for a whole round trip, leaving only the newly-attached session's
/// own replayed (and possibly days-old) numbers to render.
///
/// Keyed by gateway + profile because a different profile is a different
/// account's plan, never a stale view of this one. (Mirrors
/// `packages/react/src/lib/profile-usage-cache.ts`.)
@MainActor
enum ProfileUsageCache {
  private static var entries: [String: ProfileUsage] = [:]

  /// NUL separates unambiguously — a URL cannot contain one.
  private static func key(client: WorkerClient, profile: String) -> String {
    "\(client.baseURL.absoluteString)\u{0}\(profile)"
  }

  static func read(client: WorkerClient, profile: String) -> ProfileUsage? {
    entries[key(client: client, profile: profile)]
  }

  /// Nil is "the server reported nothing", which must not erase what we knew.
  static func write(client: WorkerClient, profile: String, usage: ProfileUsage?) {
    guard let usage else { return }
    entries[key(client: client, profile: profile)] = usage
  }
}
