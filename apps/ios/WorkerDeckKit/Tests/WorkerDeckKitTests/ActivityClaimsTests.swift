import Testing
@testable import WorkerDeckKit

@Suite("ActivityClaims")
struct ActivityClaimsTests {
  @Test("accepts a card it has not seen")
  func fresh() {
    var claims = ActivityClaims()
    #expect(claims.claim(id: "a", sessionId: "s1", hostId: "h") == .fresh)
  }

  // The bug this type exists for: ActivityKit delivered one card twice and the app ended it.
  @Test("the same card delivered twice is not a duplicate")
  func sameCardTwice() {
    var claims = ActivityClaims()
    _ = claims.claim(id: "a", sessionId: "s1", hostId: "h")
    #expect(claims.claim(id: "a", sessionId: "s1", hostId: "h") == .alreadyWatched)
  }

  @Test("a second card for one session is a duplicate")
  func secondCard() {
    var claims = ActivityClaims()
    _ = claims.claim(id: "a", sessionId: "s1", hostId: "h")
    #expect(claims.claim(id: "b", sessionId: "s1", hostId: "h") == .duplicate)
  }

  @Test("one session per host, not per session")
  func perHost() {
    var claims = ActivityClaims()
    _ = claims.claim(id: "a", sessionId: "s1", hostId: "h1")
    #expect(claims.claim(id: "b", sessionId: "s1", hostId: "h2") == .fresh)
  }

  @Test("a hostless card keeps its own slot")
  func hostless() {
    var claims = ActivityClaims()
    _ = claims.claim(id: "a", sessionId: "s1", hostId: nil)
    #expect(claims.claim(id: "b", sessionId: "s1", hostId: nil) == .duplicate)
    #expect(claims.claim(id: "c", sessionId: "s1", hostId: "h") == .fresh)
  }

  @Test("releasing frees the slot for the next card")
  func release() {
    var claims = ActivityClaims()
    _ = claims.claim(id: "a", sessionId: "s1", hostId: "h")
    claims.release(id: "a", sessionId: "s1", hostId: "h")
    #expect(claims.count == 0)
    #expect(claims.claim(id: "b", sessionId: "s1", hostId: "h") == .fresh)
  }

  // An `end` for the card that already lost the slot must not evict its replacement.
  @Test("a stale release does not free a replacement's slot")
  func staleRelease() {
    var claims = ActivityClaims()
    _ = claims.claim(id: "a", sessionId: "s1", hostId: "h")
    claims.release(id: "a", sessionId: "s1", hostId: "h")
    _ = claims.claim(id: "b", sessionId: "s1", hostId: "h")
    claims.release(id: "a", sessionId: "s1", hostId: "h")
    #expect(claims.claim(id: "c", sessionId: "s1", hostId: "h") == .duplicate)
  }
}
