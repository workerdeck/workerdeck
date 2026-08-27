import Foundation
import Testing

@testable import WorkerDeckKit

/// The steps under a session row — the port of
/// `packages/ui/test/session-steps.test.ts`.
///
/// These are the rules that caught the equivalent web bug and are worth having
/// here first: **agents sort above tasks**, and **the kind is what routes a
/// press**. The phone's list re-derived both inline and got both wrong — raw
/// dispatch order, and a `failed` agent drawing a checkmark because the only
/// branch was on `running`.
@Suite("SessionSteps")
struct SessionStepsTests {
  private func info(subagents: [SubagentInfo]?) -> SessionInfo {
    SessionInfo(
      id: "sess-00000001", status: .idle, cwd: "/work/alpha", createdAt: 1_000, lastSeq: 0,
      pendingPermissionCount: 0, lastActivityAt: 1_000, subagents: subagents)
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

  /// The rule the phone's inline version did not have. Interleaved in dispatch
  /// order the openable rows scatter through a list of markers; grouped, they
  /// are a block at the top.
  @Test("agents sort above tasks")
  func agentsFirst() {
    let steps = sessionSteps(
      info(subagents: [task("t1"), agent("a1"), task("t2"), agent("a2")]))
    #expect(steps.map(\.key) == ["a1", "a2", "t1", "t2"])
    #expect(steps.map(\.kind) == [.agent, .agent, .task, .task])
  }

  /// Stable **within** each group, deliberately: dispatch order is the only
  /// order these records have that means anything, so the partition must never
  /// reorder inside a partition.
  @Test("dispatch order survives inside each group")
  func stableWithinGroup() {
    let steps = sessionSteps(
      info(subagents: [
        agent("a1"), task("t1"), agent("a2"), task("t2"), agent("a3"), task("t3"),
      ]))
    #expect(steps.map(\.key) == ["a1", "a2", "a3", "t1", "t2", "t3"])
  }

  @Test("no sub-agents is no steps, and nil is not a crash")
  func empty() {
    #expect(sessionSteps(info(subagents: nil)).isEmpty)
    #expect(sessionSteps(info(subagents: [])).isEmpty)
  }

  // MARK: - Kind

  /// The kind is what routes the press: an agent opens its own frame, a task
  /// opens the session and travels to that call's row. Framing a task's id
  /// selects no items, which is exactly the empty agent view the web shipped.
  @Test("the kind is isAgentRecord, nothing else")
  func kindFollowsAgentRecord() {
    let steps = sessionSteps(
      info(subagents: [
        agent("a1"),
        // A blank `agentType` is not an agent — the trimming rule.
        SubagentInfo(
          toolUseId: "a2", agentType: "   ", description: "hm", status: .done, startedAt: 1,
          toolCount: 0),
        task("t1"),
      ]))
    #expect(steps.first { $0.key == "a1" }?.kind == .agent)
    #expect(steps.first { $0.key == "a2" }?.kind == .task)
    #expect(steps.first { $0.key == "t1" }?.kind == .task)
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

  @Test("running steps are counted, settled ones are not")
  func running() {
    let steps = sessionSteps(
      info(subagents: [
        agent("a1", status: .running), agent("a2", status: .failed),
        task("t1", status: .running), task("t2"),
      ]))
    #expect(runningSteps(steps) == 2)
    #expect(runningSteps([]) == 0)
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
      info(subagents: [
        agent("a1"), agent("a2", description: nil), task("t1"),
        SubagentInfo(
          toolUseId: "t2", agentType: nil, description: nil, status: .done, startedAt: 1,
          toolCount: 0),
      ]))
    #expect(steps.map(\.label) == ["Explore · find the auth check", "Explore", "rewrite the loader", "Sub-agent"])
  }

  /// The two spellings of one count. The phone had a hand-rolled copy of this
  /// on the row's chip beside `StepToggle`'s — one derivation now.
  @Test("the count reads live while any are running and settles to a total")
  func countSpellings() {
    #expect(stepCountLabel(running: 1, total: 3) == "1/3")
    #expect(stepCountLabel(running: 0, total: 3) == "3")
    // All of them running is a total too: `3/3` says nothing `3` does not.
    #expect(stepCountLabel(running: 3, total: 3) == "3")
    #expect(stepCountWords(running: 1, total: 3) == "1 of 3 agents running")
    #expect(stepCountWords(running: 0, total: 3) == "3 agents")
    #expect(stepCountWords(running: 0, total: 1) == "1 agent")
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
    // The key must be a *string* — a number there is somebody else's metadata.
    let notAJob = SessionInfo(
      id: "s3", status: .idle, cwd: "/work", createdAt: 1, lastSeq: 0, pendingPermissionCount: 0,
      meta: ["jobId": .number(7)])
    #expect(!isJobRun(notAJob))
  }
}
