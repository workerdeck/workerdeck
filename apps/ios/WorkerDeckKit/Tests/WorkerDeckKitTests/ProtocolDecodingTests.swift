import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Protocol decoding")
struct ProtocolDecodingTests {
  /// The CLI names its rows with aliases and reports a resolved wire id; the chip
  /// is only useful if those meet.
  @Test func matchesTheModelASessionReports() throws {
    let opus = ModelOption(
      value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)")
    #expect(opus.matches("opus[1m]"))
    #expect(opus.matches("claude-opus-5[1m]"))
    #expect(opus.matches("claude-opus-5"))
    #expect(!opus.matches("claude-sonnet-5"))

    // Same family, older version: it must NOT also read as checked, which is the
    // whole reason a declared `resolvedModel` outranks the family heuristic.
    let previousOpus = ModelOption(
      value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8")
    #expect(!previousOpus.matches("claude-opus-5[1m]"))
    #expect(previousOpus.matches("claude-opus-4-8"))

    // No `resolvedModel` (a CLI that omits it): the family
    // token still gets the name right.
    let sonnet = ModelOption(value: "sonnet", displayName: "Sonnet")
    #expect(sonnet.matches("claude-sonnet-5[1m]"))
    #expect(!sonnet.matches("claude-haiku-4-5"))
  }
}
