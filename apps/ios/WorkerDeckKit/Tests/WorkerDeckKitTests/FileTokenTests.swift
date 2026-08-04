import Testing

@testable import WorkerDeckKit

@Suite("FileToken")
struct FileTokenTests {
  @Test func findsATokenAtTheEndOfTheDraft() {
    #expect(FileToken.query(in: "look at @src/Ses") == "src/Ses")
    #expect(FileToken.query(in: "@") == "")
    #expect(FileToken.query(in: "@README.md") == "README.md")
  }

  @Test func stopsAtWhitespaceAndNewlines() {
    // A trailing space is how accepting a completion closes the list.
    #expect(FileToken.query(in: "@src/index.ts ") == nil)
    #expect(FileToken.query(in: "@notes\nnow explain") == nil)
    #expect(FileToken.query(in: "first @a then @b") == "b")
  }

  @Test func requiresTheAtToStartTheWord() {
    // Otherwise every email address opens a file picker.
    #expect(FileToken.query(in: "mail toby@example.com") == nil)
    #expect(FileToken.query(in: "x@y") == nil)
  }

  @Test func isNilForDraftsWithNoToken() {
    #expect(FileToken.query(in: "") == nil)
    #expect(FileToken.query(in: "no token here") == nil)
    #expect(FileToken.query(in: "trailing space ") == nil)
  }

  @Test func replacesTheTokenAndLeavesTheRestAlone() {
    #expect(
      FileToken.apply("src/SessionListView.swift", to: "look at @src/Ses")
        == "look at @src/SessionListView.swift ")
    // The bare `@` case: nothing typed yet, everything before it preserved.
    #expect(FileToken.apply("a.txt", to: "explain @") == "explain @a.txt ")
    // No token: the draft is returned untouched rather than appended to.
    #expect(FileToken.apply("a.txt", to: "already sent ") == "already sent ")
  }

  @Test func replacesOnlyTheLastToken() {
    #expect(
      FileToken.apply("two.md", to: "compare @one.md and @tw") == "compare @one.md and @two.md ")
  }
}
