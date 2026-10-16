import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Shells")
struct ShellTests {
  // MARK: - The record

  @Test func anUnknownEndReasonFallsBackRatherThanThrowing() throws {
    let decoded = try JSONDecoder().decode(
      ShellInfo.self,
      from: Data(
        #"""
        {"id":"sh_x","sessionId":"sess-1","ordinal":2,"command":"sleep 9","label":"sleep 9",
         "cwd":"/work","owner":"agent","status":"exited","startedAt":1000,"endedAt":2000,
         "endReason":"evicted_by_the_future","bytes":0,"cols":120,"rows":40}
        """#.utf8))
    #expect(decoded.endReason == .unknown)
    #expect(decoded.owner == .agent)
  }

  /// A record this build cannot parse at all degrades to the local-command
  /// notice every older client already draws - never to a lost message.
}
