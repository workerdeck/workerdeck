import Foundation

/// Is this approval a **plan** rather than a tool call? — a port of
/// `packages/ui/src/lib/plan-request.ts`.
///
/// `ExitPlanMode` arrives on the ordinary permission channel, but nothing about
/// it is ordinary: what is being approved is prose the reader has to *read*, and
/// the answer is not "allow/deny" but "go ahead" or "keep planning". Every
/// client therefore branches on this one predicate, so it lives beside the
/// protocol types rather than inside either renderer — the cards prompt and the
/// terminal prompt must never disagree about what a plan is.
public enum PlanRequest {
  /// The plan's markdown, or `nil` when this is a normal tool approval.
  ///
  /// Nil-on-anything-unexpected is the point: a blank or non-string `plan` is a
  /// plan prompt with nothing to read, whose "Approve plan" button would ask the
  /// reader to approve an empty card. Falling back to the tool-call shape at
  /// least shows them the request.
  public static func plan(from request: PermissionRequest?) -> String? {
    guard let request, request.toolName == "ExitPlanMode" else { return nil }
    guard let plan = request.input.objectValue?["plan"]?.stringValue else { return nil }
    return plan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : plan
  }
}
