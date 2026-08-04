import Testing

@testable import WorkerDeckKit

@Suite("PromptTokens")
struct PromptTokenTests {

  // MARK: - Drafts (composer completion)

  @Test func findsTheTokenAtTheEndOfTheDraft() {
    #expect(PromptTokens.active(in: "look at @src/Ses")?.query == "src/Ses")
    // A bare `@` is a token: the server answers the empty query with the
    // shallowest files in the directory.
    #expect(PromptTokens.active(in: "@")?.query == "")
    #expect(PromptTokens.active(in: "@README.md")?.kind == .file)
  }

  @Test func stopsAtWhitespaceAndNewlines() {
    // A trailing space is how accepting a completion closes the list.
    #expect(PromptTokens.active(in: "@src/index.ts ") == nil)
    #expect(PromptTokens.active(in: "@notes\nnow explain") == nil)
    #expect(PromptTokens.active(in: "first @a then @b")?.query == "b")
  }

  @Test func requiresTheAtToStartTheWord() {
    // Otherwise every email address opens a file picker.
    #expect(PromptTokens.active(in: "mail toby@example.com") == nil)
    #expect(PromptTokens.active(in: "x@y") == nil)
  }

  @Test func isNilForDraftsWithNoToken() {
    #expect(PromptTokens.active(in: "") == nil)
    #expect(PromptTokens.active(in: "no token here") == nil)
    #expect(PromptTokens.active(in: "trailing space ") == nil)
  }

  @Test func commandsNeedOnlyAWordBoundary() {
    #expect(PromptTokens.active(in: "/comm")?.kind == .command)
    #expect(PromptTokens.active(in: "/comm")?.query == "comm")
    #expect(PromptTokens.active(in: "  /comm")?.kind == .command)
    // The picker is an editing aid, so it opens mid-draft too — reaching for a
    // command halfway through a sentence should not mean typing the name by hand.
    #expect(PromptTokens.active(in: "run /comm")?.kind == .command)
    #expect(PromptTokens.active(in: "run /comm")?.query == "comm")
    // A slash inside a word is still just a slash.
    #expect(PromptTokens.active(in: "and/or") == nil)
  }

  @Test func readsTheTokenAroundACursorMidMessage() {
    let text = "look at @src/Ses and then stop"
    // Cursor inside the token: the whole word is returned, so accepting replaces
    // what was typed rather than splicing into it.
    let cursor = text.index(text.startIndex, offsetBy: 13)
    #expect(PromptTokens.active(in: text, at: cursor)?.query == "src/Ses")
    // Cursor in a later word is not in the token.
    let later = text.index(text.startIndex, offsetBy: 20)
    #expect(PromptTokens.active(in: text, at: later) == nil)
    // Cursor immediately *before* the `@` is not inside it either.
    let before = text.index(text.startIndex, offsetBy: 8)
    #expect(PromptTokens.active(in: text, at: before) == nil)
  }

  // MARK: - Replacement

  @Test func replacesTheTokenAndLeavesTheRestAlone() {
    let draft = "look at @src/Ses"
    let token = PromptTokens.active(in: draft)!
    let result = PromptTokens.apply("src/SessionListView.swift", replacing: token, in: draft)
    #expect(result.text == "look at @src/SessionListView.swift ")
    #expect(result.cursor == result.text.endIndex)
  }

  @Test func replacesInPlaceMidMessage() {
    let draft = "compare @one.md and @tw here"
    let cursor = draft.index(draft.startIndex, offsetBy: 23)
    let token = PromptTokens.active(in: draft, at: cursor)!
    let result = PromptTokens.apply("two.md", replacing: token, in: draft)
    // The space already after the token is reused rather than doubled…
    #expect(result.text == "compare @one.md and @two.md here")
    // …and the caret lands past it, ready for the next word.
    #expect(result.text.distance(from: result.text.startIndex, to: result.cursor) == 28)
  }

  @Test func replacesACommandWithItsSlash() {
    let draft = "/comm"
    let token = PromptTokens.active(in: draft)!
    #expect(PromptTokens.apply("commit-message", replacing: token, in: draft).text
      == "/commit-message ")
  }

  // MARK: - Finished text (transcript styling)

  @Test func scansEveryTokenInASentMessage() {
    let text = "/review compare @one.md with @src/two.ts please"
    let tokens = PromptTokens.scan(text)
    #expect(tokens.map(\.text) == ["/review", "@one.md", "@src/two.ts"])
    #expect(tokens.map(\.kind) == [.command, .file, .file])
  }

  @Test func leavesSentencePunctuationOutOfTheToken() {
    #expect(PromptTokens.scan("see @README.md.").map(\.text) == ["@README.md"])
    #expect(PromptTokens.scan("check @a.ts, @b.ts and @c.ts!").map(\.text)
      == ["@a.ts", "@b.ts", "@c.ts"])
  }

  @Test func doesNotStyleABareAtOrAPastedPath() {
    // Typing `@` opens the picker; an `@` sitting in a sent message is an at sign.
    #expect(PromptTokens.scan("just an @ sign").isEmpty)
    // A path is not a command wherever it appears — which is the whole reason a
    // command name may not contain a slash, now that position no longer rules it
    // out.
    #expect(PromptTokens.scan("/Users/atomic/projects is where it lives").isEmpty)
    #expect(PromptTokens.scan("it lives in /Users/atomic/projects").isEmpty)
    #expect(PromptTokens.scan("mail toby@example.com").isEmpty)
  }

  @Test func confirmedLeavesTheWordStillBeingTypedAlone() {
    // Accepting a suggestion appends the space, so the token it inserted is
    // confirmed the moment it lands…
    #expect(PromptTokens.confirmed(in: "look at @src/a.ts ").map(\.text) == ["@src/a.ts"])
    // …while the one halfway through being typed is not yet anything.
    #expect(PromptTokens.confirmed(in: "look at @src/a").isEmpty)
    #expect(PromptTokens.confirmed(in: "@one.md and @tw").map(\.text) == ["@one.md"])
    #expect(PromptTokens.confirmed(in: "/review the @file.ts now").map(\.text)
      == ["/review", "@file.ts"])
  }

  @Test func scanRangesAddressTheOriginalText() {
    let text = "see @README.md."
    let token = PromptTokens.scan(text)[0]
    #expect(String(text[token.range]) == "@README.md")
    #expect(text.distance(from: text.startIndex, to: token.range.lowerBound) == 4)
  }
}
