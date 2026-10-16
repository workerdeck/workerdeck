import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Shells")
struct ShellTests {
  private func shell(
    id: String = "sh_abc123", status: ShellStatus = .running, startedAt: Double = 1_000,
    endedAt: Double? = nil, exitCode: Int? = nil, endReason: ShellEndReason? = nil,
    command: String = "npm test", label: String = "npm test"
  ) -> ShellInfo {
    ShellInfo(
      id: id, sessionId: "sess-1", ordinal: 3, command: command, label: label, cwd: "/work",
      status: status, startedAt: startedAt, endedAt: endedAt, exitCode: exitCode,
      endReason: endReason, bytes: 42)
  }

  // MARK: - The record

  @Test func decodesAShellRecordOffAUserMessage() throws {
    let event = try JSONDecoder().decode(
      SessionEvent.self,
      from: Data(
        #"""
        {"type":"user_message","seq":9,"ts":1722300000000,"uuid":"row-1","synthetic":true,
         "message":{"role":"user","content":"<local-command-stdout>$ ls\nREADME.md\n[exit 0]</local-command-stdout>"},
         "shell":{"id":"sh_abc","sessionId":"sess-1","ordinal":1,"command":"ls","label":"ls",
          "cwd":"/work","owner":"user","status":"exited","startedAt":1000,"endedAt":1200,
          "exitCode":0,"endReason":"exit","bytes":11,"cols":120,"rows":40}}
        """#.utf8))
    guard case .userMessage(let payload) = event.body, let shell = payload.shell else {
      Issue.record("expected a user_message carrying a shell, got \(event.body)")
      return
    }
    #expect(shell.id == "sh_abc")
    #expect(shell.ordinal == 1)
    #expect(shell.owner == .user)
    #expect(shell.status == .exited)
    #expect(shell.endReason == .exit)
    #expect(shell.exitCode == 0)
    #expect(shell.capped == nil)
  }

  /// The one lenient union in the mirror. A reason this build has never heard of
  /// must read as `.unknown`, because the alternative is a failed decode that
  /// takes the whole message down - and widening the Swift side later would cost
  /// a `PROTOCOL_VERSION` bump.
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
  @Test func anUndecodableShellLeavesTheMessageStanding() throws {
    let event = try JSONDecoder().decode(
      SessionEvent.self,
      from: Data(
        #"""
        {"type":"user_message","seq":9,"ts":1722300000000,"uuid":"row-1","synthetic":true,
         "message":{"role":"user","content":"<local-command-stdout>hi</local-command-stdout>"},
         "shell":{"id":"sh_abc","status":"suspended"}}
        """#.utf8))
    guard case .userMessage(let payload) = event.body else {
      Issue.record("expected a user_message, got \(event.body)")
      return
    }
    #expect(payload.shell == nil)
  }

  // MARK: - The session list

  @Test func promotedShellsKeepsWhatIsWorthALine() {
    func info(_ shells: [ShellInfo]) -> SessionInfo {
      SessionInfo(
        id: "sess-1", status: .idle, cwd: "/work", createdAt: 0, lastSeq: 0,
        pendingPermissionCount: 0, shells: shells)
    }
    let now: Double = 100_000
    let young = shell(id: "young", startedAt: now - 500)
    let long = shell(id: "long", startedAt: now - 10_000)
    let quickFail = shell(
      id: "quick", status: .exited, startedAt: now - 1_500, endedAt: now - 1_000, exitCode: 1)
    let slowFail = shell(
      id: "slow", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000, exitCode: 1)
    let oldFail = shell(
      id: "old", status: .exited, startedAt: now - 200_000, endedAt: now - 90_000, exitCode: 1)
    let cleanExit = shell(
      id: "clean", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000, exitCode: 0)
    let killed = shell(
      id: "killed", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000,
      endReason: .killed)

    let restarted = shell(
      id: "restarted", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000,
      endReason: .serverRestarted)

    let promoted = promotedShells(
      info([young, long, quickFail, slowFail, oldFail, cleanExit, killed, restarted]), now: now)
    #expect(promoted.map(\.id) == ["long", "slow"])
    #expect(promotedShells(info([]), now: now).isEmpty)
  }

  /// The linger is for a failure the operator has not been told about. A shell
  /// they killed, and one a restart reconciled, both report **no exit code at
  /// all** - and reading "not zero" as "failed" kept each of them on the card
  /// for a minute wearing a failure's colour.
  @Test func neitherAKillNorARestartLingersOnTheCard() {
    func info(_ shells: [ShellInfo]) -> SessionInfo {
      SessionInfo(
        id: "sess-1", status: .idle, cwd: "/work", createdAt: 0, lastSeq: 0,
        pendingPermissionCount: 0, shells: shells)
    }
    let now: Double = 100_000
    for reason in [ShellEndReason.killed, .serverStopped, .serverRestarted] {
      let ended = shell(
        id: "sh", status: .exited, startedAt: now - 10_000, endedAt: now - 1_000,
        endReason: reason)
      #expect(promotedShells(info([ended]), now: now).isEmpty)
    }
  }
}
