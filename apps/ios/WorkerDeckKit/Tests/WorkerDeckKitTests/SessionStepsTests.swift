import Foundation
import Testing

@testable import WorkerDeckKit

/// The steps under a session row - the port of
/// `packages/ui/test/session-steps.test.ts`.
///
/// Steps are sub-agents only: an untyped record is a task, and tasks live in
/// the selected session's own surface. The phone's list re-derived this inline
/// and got it wrong - a `failed` agent drew a checkmark because the only branch
/// was on `running`.
@Suite("SessionSteps")
struct SessionStepsTests {
  private func info(subagents: [SubagentInfo]?, shells: [ShellInfo]? = nil) -> SessionInfo {
    SessionInfo(
      id: "sess-00000001", status: .idle, cwd: "/work/alpha", createdAt: 1_000, lastSeq: 0,
      pendingPermissionCount: 0, lastActivityAt: 1_000, subagents: subagents, shells: shells)
  }

  private func shell(
    _ id: String = "sh_1", status: ShellStatus = .running, startedAt: Double = 0,
    endedAt: Double? = nil, exitCode: Int? = nil, endReason: ShellEndReason? = nil
  ) -> ShellInfo {
    ShellInfo(
      id: id, sessionId: "sess-00000001", ordinal: 2, command: "npm run dev",
      label: "npm run dev", cwd: "/work/alpha", status: status, startedAt: startedAt,
      endedAt: endedAt, exitCode: exitCode, endReason: endReason)
  }

  private func agent(
    _ id: String, type: String = "Explore", description: String? = "find the auth check",
    status: SubagentStatus = .done, toolCount: Int = 3
  ) -> SubagentInfo {
    SubagentInfo(
      toolUseId: id, agentType: type, description: description, status: status, startedAt: 1_000,
      toolCount: toolCount)
  }

  private func task(
    _ id: String, description: String? = "rewrite the loader",
    status: SubagentStatus = .done, toolCount: Int = 0
  ) -> SubagentInfo {
    SubagentInfo(
      toolUseId: id, agentType: nil, description: description, status: status, startedAt: 1_000,
      toolCount: toolCount)
  }

  // MARK: - Order

  @Test("untyped records are not steps")
  func tasksAreNotSteps() {
    let steps = sessionSteps(
      info(subagents: [task("t1"), agent("a1"), task("t2"), agent("a2")]))
    #expect(steps.map(\.key) == ["a1", "a2"])
  }

  /// Dispatch order is the only order these records have that means anything,
  /// so the filter must never reorder what it keeps.
  @Test("dispatch order survives the filter")
  func stableOrder() {
    let steps = sessionSteps(
      info(subagents: [
        agent("a1"), task("t1"), agent("a2"), task("t2"), agent("a3"), task("t3"),
      ]))
    #expect(steps.map(\.key) == ["a1", "a2", "a3"])
  }

  @Test("no sub-agents is no steps, and nil is not a crash")
  func empty() {
    #expect(sessionSteps(info(subagents: nil)).isEmpty)
    #expect(sessionSteps(info(subagents: [])).isEmpty)
  }

  // MARK: - Membership

  @Test("membership is isAgentRecord, nothing else")
  func membershipFollowsAgentRecord() {
    let steps = sessionSteps(
      info(subagents: [
        agent("a1"),
        // A blank `agentType` is not an agent - the trimming rule.
        SubagentInfo(
          toolUseId: "a2", agentType: "   ", description: "hm", status: .done, startedAt: 1,
          toolCount: 0),
        task("t1"),
      ]))
    #expect(steps.map(\.key) == ["a1"])
  }

  // MARK: - State

  /// All four arms, and the one that was wrong: `failed` used to fall through
  /// to the `done` checkmark, so a broken agent read as a finished one.
  @Test("every status maps to its own state")
  func statesAreDistinct() {
    #expect(stepState(.running) == .running)
    #expect(stepState(.failed) == .failed)
    #expect(stepState(.done) == .done)
    let steps = sessionSteps(
      info(subagents: [
        agent("a1", status: .running), agent("a2", status: .failed), agent("a3", status: .done),
      ]))
    #expect(steps.map(\.state) == [.running, .failed, .done])
  }

  /// A failed record is not a completed one, so `.active` keeps it: it is the
  /// row most worth reading on a card that has gone quiet.
  @Test("the display preference decides which records draw")
  func display() {
    let session = info(subagents: [
      agent("a1", status: .running), agent("a2", status: .failed), agent("a3", status: .done),
    ])
    #expect(sessionSteps(session, .all).map(\.key) == ["a1", "a2", "a3"])
    #expect(sessionSteps(session, .active).map(\.key) == ["a1", "a2"])
    #expect(sessionSteps(session, .none).isEmpty)
    #expect(visibleSubagents(session, .active).map(\.toolUseId) == ["a1", "a2"])
    #expect(visibleSubagents(info(subagents: nil), .all).isEmpty)
  }

  // MARK: - The reading

  /// Zero draws nothing: `0` beside a thinking agent reads as a stall.
  @Test("a zero tool count has no detail")
  func detailHidesZero() {
    let steps = sessionSteps(
      info(subagents: [agent("a1", toolCount: 0), agent("a2", toolCount: 1)]))
    #expect(steps[0].detail == nil)
    #expect(steps[1].detail == "1")
    #expect(steps[1].title == "Explore · find the auth check · 1 tool")
    #expect(steps[0].title == "Explore · find the auth check · 0 tools")
  }

  /// The label is protocol's `subagentLabel`, never a spelling of its own.
  @Test("the label is the shared one")
  func label() {
    let steps = sessionSteps(
      info(subagents: [agent("a1"), agent("a2", description: nil), task("t1")]))
    #expect(steps.map(\.label) == ["Explore · find the auth check", "Explore"])
  }

  // MARK: - Shells

  /// Shells are a block after the agents, not interleaved by timestamp: a
  /// `$ npm run dev` between two agents would read as part of the agent's work.
  @Test("promoted shells follow the agents")
  func shellsComeLast() {
    let steps = sessionSteps(
      info(subagents: [agent("a1")], shells: [shell("sh_1", startedAt: 0)]),
      .all, now: 5_000)
    #expect(steps.map(\.key) == ["a1", "sh_1"])
    #expect(steps.map(\.kind) == [.agent, .shell])
    #expect(steps[1].label == "npm run dev")
    #expect(steps[1].noun == "shell")
  }

  /// `now` decides which shells earn a line, so omitting it means "this surface
  /// has nowhere to send a shell press" rather than "this session has none".
  @Test("without a clock there are no shell steps")
  func shellsNeedANow() {
    let steps = sessionSteps(info(subagents: [agent("a1")], shells: [shell(startedAt: 0)]))
    #expect(steps.map(\.key) == ["a1"])
  }

  /// Only a running shell can be stopped from a card, and a kill glyph beside
  /// anything else would promise something no client can do.
  @Test("only a running shell is killable")
  func onlyRunningIsKillable() {
    let running = sessionSteps(info(subagents: nil, shells: [shell(startedAt: 0)]), .all, now: 5_000)
    #expect(running.map(\.killable) == [true])
    #expect(running[0].detail == nil)
    #expect(running[0].state == .running)

    let failed = shell(
      "sh_2", status: .exited, startedAt: 0, endedAt: 4_000, exitCode: 1, endReason: .exit)
    let settled = sessionSteps(info(subagents: nil, shells: [failed]), .all, now: 5_000)
    #expect(settled.map(\.killable) == [false])
    #expect(settled[0].state == .failed)
    #expect(settled[0].detail == "exit 1")
    #expect(settled[0].title == "#2 npm run dev · exit 1")
  }

  /// The `none` display is about sub-agents. A shell is not one, so hiding them
  /// must not hide it: an operator who collapsed the agent lines did not ask to
  /// stop being told a dev server is running.
  @Test("hiding sub-agents keeps the shells")
  func subagentDisplayDoesNotHideShells() {
    let steps = sessionSteps(
      info(subagents: [agent("a1")], shells: [shell(startedAt: 0)]), .none, now: 5_000)
    #expect(steps.map(\.key) == ["sh_1"])
  }

  // MARK: - Job runs

  /// Mirrored so that the day the phone grows a jobs surface, "should the list
  /// show these" is a decision already made rather than one rediscovered.
  @Test("a job run is the one stamped with meta.jobId")
  func jobRun() {
    let plain = SessionInfo(
      id: "s1", status: .idle, cwd: "/work", createdAt: 1, lastSeq: 0, pendingPermissionCount: 0)
    #expect(!isJobRun(plain))
    let job = SessionInfo(
      id: "s2", status: .idle, cwd: "/work", createdAt: 1, lastSeq: 0, pendingPermissionCount: 0,
      meta: ["jobId": .string("job-1")])
    #expect(isJobRun(job))
    // The key must be a *string* - a number there is somebody else's metadata.
    let notAJob = SessionInfo(
      id: "s3", status: .idle, cwd: "/work", createdAt: 1, lastSeq: 0, pendingPermissionCount: 0,
      meta: ["jobId": .number(7)])
    #expect(!isJobRun(notAJob))
  }
}
