import Testing

@testable import WorkerDeckKit

/// The bookmark map — the semantics of the web's `useBookmarks`
/// (`workerdeck.bookmarks.v1`), which is the contract here: a mark set on the
/// phone must mean the same thing a mark set in the dashboard means, or the two
/// clients are annotating different transcripts that happen to share a name.
@Suite("Bookmarks")
struct BookmarksTests {
  /// An in-memory store standing in for UserDefaults, keeping the last write —
  /// the shape `WatermarksTests` uses, because the seam is the same idea.
  private final class StoreBox {
    var data: [String: [String]]

    init(_ initial: [String: [String]] = [:]) {
      data = initial
    }

    var seam: BookmarkStore {
      BookmarkStore(
        read: { [self] in data },
        write: { [self] map in data = map })
    }
  }

  @Test func togglesMembershipById() {
    let marks = Bookmarks(store: StoreBox().seam)
    #expect(marks.toggle(hostId: "mac", sessionId: "a", itemId: "text-4"))
    #expect(marks.isBookmarked(hostId: "mac", sessionId: "a", itemId: "text-4"))
    #expect(!marks.toggle(hostId: "mac", sessionId: "a", itemId: "text-4"))
    #expect(!marks.isBookmarked(hostId: "mac", sessionId: "a", itemId: "text-4"))
  }

  @Test func keepsInsertionOrderBecauseTheWebDoes() {
    // The order is part of the mirrored contract, not decoration — the web
    // appends and filters, so a set here would be a second answer to "what is
    // stored" the day anything renders the list.
    let marks = Bookmarks(store: StoreBox().seam)
    for id in ["c", "a", "b"] { marks.toggle(hostId: "mac", sessionId: "s", itemId: id) }
    marks.toggle(hostId: "mac", sessionId: "s", itemId: "a")
    #expect(marks.bookmarks(hostId: "mac", sessionId: "s") == ["c", "b"])
  }

  @Test func sessionsAreIndependent_andSoAreHosts() {
    // One flat map, keyed `host:session` — the same key `watermarkKey` spells —
    // so the same session id on two gateways is two memberships.
    let marks = Bookmarks(store: StoreBox().seam)
    marks.toggle(hostId: "mac", sessionId: "s1", itemId: "x")
    marks.toggle(hostId: "mac", sessionId: "s2", itemId: "y")
    marks.toggle(hostId: "pi", sessionId: "s1", itemId: "z")
    #expect(marks.bookmarks(hostId: "mac", sessionId: "s1") == ["x"])
    #expect(marks.bookmarks(hostId: "mac", sessionId: "s2") == ["y"])
    #expect(marks.bookmarks(hostId: "pi", sessionId: "s1") == ["z"])
  }

  @Test func anEmptiedSessionLeavesTheMapEntirely() {
    // The web deletes the emptied key. Kept in step so storage never accrues a
    // tombstone per session someone once starred and unstarred.
    let box = StoreBox()
    let marks = Bookmarks(store: box.seam)
    marks.toggle(hostId: "mac", sessionId: "s", itemId: "x")
    #expect(box.data["mac:s"] == ["x"])
    marks.toggle(hostId: "mac", sessionId: "s", itemId: "x")
    #expect(box.data["mac:s"] == nil)
    #expect(box.data.isEmpty)
  }

  @Test func readsWhatAnEarlierRunWrote() {
    let box = StoreBox(["mac:s": ["user-2", "toolu_9"]])
    let marks = Bookmarks(store: box.seam)
    #expect(marks.bookmarks(hostId: "mac", sessionId: "s") == ["user-2", "toolu_9"])
    // And a missing store is an empty map, never a crash — losing the file
    // costs starred rows, nothing structural.
    let cold = Bookmarks(store: BookmarkStore(read: { nil }, write: { _ in }))
    #expect(cold.bookmarks(hostId: "mac", sessionId: "s").isEmpty)
  }
}
