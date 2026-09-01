import Foundation
import Testing

@testable import WorkerDeckKit

/// What counts as a plan approval.
///
/// The predicate is small and both prompt renderers branch on it, so the edges
/// are what matter: anything it says yes to gets a card with no tool name, no
/// input summary and a button that reads "Approve plan".
@Suite("PlanRequest")
struct PlanRequestTests {
  private func request(tool: String, input: JSONValue) -> PermissionRequest {
    PermissionRequest(id: "r1", toolName: tool, input: input, toolUseId: "t1")
  }

  @Test("ExitPlanMode with a plan is a plan")
  func recognisesAPlan() {
    let plan = "## Steps\n\n1. Do the thing"
    #expect(
      PlanRequest.plan(from: request(tool: "ExitPlanMode", input: .object(["plan": .string(plan)])))
        == plan)
  }

  @Test("the plan is handed back unmodified, so the renderer sees the markdown it was given")
  func planIsVerbatim() {
    // Trimmed only for the *emptiness* test — leading whitespace can be a fenced
    // block's indentation, and eating it would change what the plan says.
    let plan = "   - indented\n\n"
    #expect(
      PlanRequest.plan(from: request(tool: "ExitPlanMode", input: .object(["plan": .string(plan)])))
        == plan)
  }

  @Test("anything else is an ordinary tool approval")
  func rejectsEverythingElse() {
    #expect(PlanRequest.plan(from: nil) == nil)
    // The right shape under the wrong tool: a Bash call is never a plan.
    #expect(PlanRequest.plan(from: request(tool: "Bash", input: .object(["plan": .string("x")]))) == nil)
    // The right tool with nothing to read — the case that would otherwise draw
    // an empty card asking the reader to approve it.
    #expect(PlanRequest.plan(from: request(tool: "ExitPlanMode", input: .object(["plan": .string("  \n ")]))) == nil)
    #expect(PlanRequest.plan(from: request(tool: "ExitPlanMode", input: .object([:]))) == nil)
    #expect(PlanRequest.plan(from: request(tool: "ExitPlanMode", input: .object(["plan": .number(1)]))) == nil)
    #expect(PlanRequest.plan(from: request(tool: "ExitPlanMode", input: .null)) == nil)
  }
}
