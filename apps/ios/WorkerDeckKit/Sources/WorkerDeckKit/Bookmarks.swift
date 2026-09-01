import Foundation

/// The reader's own marks on a transcript — which items, per session — the
/// semantics of the web client's `useBookmarks`
/// (`packages/web/src/hooks/useBookmarks.ts`, localStorage key
/// `workerdeck.bookmarks.v1`).
///
/// Bookmarks are transcript item **ids, not indexes**: an index is an artifact
/// of one replay's coalescing, an id survives it — the same argument that keyed
/// the web seam, mirrored here so a mark means the same thing on every client
/// that draws it. Membership is per `host:session`, stored flat so one map
/// covers every gateway; losing the map costs starred rows, nothing structural,
/// which is why the app-side read swallows a decode failure rather than
/// guarding one.
///
/// Not a protocol port the way `Watermarks` is — no shared `bookmarks.ts`
/// exists — but the rules live in the kit for the reason `MarkdownBlocks`'s do:
/// this package is the only part of the app under test, and toggle semantics
/// are exactly the kind of pure logic whose interesting cases are all edges.
public struct BookmarkStore {
  public var read: () -> [String: [String]]?
  public var write: ([String: [String]]) -> Void

  public init(
    read: @escaping () -> [String: [String]]?,
    write: @escaping ([String: [String]]) -> Void
  ) {
    self.read = read
    self.write = write
  }
}

/// The same spelling as `watermarkKey`, deliberately: both maps are "this
/// reader's memory of one session on one gateway", and two key shapes would be
/// two answers to which session that is.
public func bookmarkKey(hostId: String, sessionId: String) -> String {
  "\(hostId):\(sessionId)"
}

public final class Bookmarks {
  private let store: BookmarkStore
  private var cache: [String: [String]]

  public init(store: BookmarkStore) {
    self.store = store
    cache = store.read() ?? [:]
  }

  /// One session's marks, in the order they were set. An array rather than a
  /// set because the web keeps insertion order and the granularity of what is
  /// persisted is part of the mirrored contract, not a storage detail.
  public func bookmarks(hostId: String, sessionId: String) -> [String] {
    cache[bookmarkKey(hostId: hostId, sessionId: sessionId)] ?? []
  }

  public func isBookmarked(hostId: String, sessionId: String, itemId: String) -> Bool {
    bookmarks(hostId: hostId, sessionId: sessionId).contains(itemId)
  }

  /// Add the mark if absent, remove it if present; returns whether the item is
  /// bookmarked *now*. A session whose last mark was removed leaves the map
  /// entirely — the web deletes the emptied key, so storage never accrues a
  /// tombstone per session someone once starred and unstarred.
  @discardableResult
  public func toggle(hostId: String, sessionId: String, itemId: String) -> Bool {
    let key = bookmarkKey(hostId: hostId, sessionId: sessionId)
    let current = cache[key] ?? []
    let added: Bool
    if current.contains(itemId) {
      let next = current.filter { $0 != itemId }
      if next.isEmpty {
        cache.removeValue(forKey: key)
      } else {
        cache[key] = next
      }
      added = false
    } else {
      cache[key] = current + [itemId]
      added = true
    }
    store.write(cache)
    return added
  }
}
