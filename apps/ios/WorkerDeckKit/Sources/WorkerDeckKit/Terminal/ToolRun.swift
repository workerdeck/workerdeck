import Foundation

/// The wording of a folded tool run and of a folded `Task` — a port of
/// `packages/ui/src/components/terminal/tool-run.ts`.
///
/// These strings live apart from the views for one reason: the height
/// calculator wraps **these exact strings** to predict a row's height with no
/// layout pass. Two spellings would be two different heights, and the row would
/// jump the moment it mounted.

// MARK: - Membership

/// Do two consecutive tool calls belong to the same run?
///
/// Same parent, and that is the whole rule — consecutiveness is enforced by the
/// caller, and a failure deliberately does **not** split a run (it colours it;
/// fragmenting around a failure hides it in a longer list rather than surfacing
/// it). A subagent's calls are drawn stepped in behind a rule, so folding one
/// together with a top-level call would count rows that are not adjacent on
/// screen.
public func foldsTogether(_ a: ToolCallItem, _ b: ToolCallItem) -> Bool {
  a.parentToolUseId == b.parentToolUseId
}

/// The family a tool is counted under in a run's breakdown: `shell` for either
/// engine's shell tool, the **server name** for an MCP tool
/// (`mcp__roam_code__search` → `roam-code`), else the lowercased name.
public func toolFamily(_ name: String) -> String {
  if isShellTool(name) { return "shell" }
  if name.hasPrefix("mcp__") {
    let rest = name.dropFirst("mcp__".count)
    if let separator = rest.range(of: "__"), !rest[rest.startIndex..<separator.lowerBound].isEmpty {
      let server = String(rest[rest.startIndex..<separator.lowerBound])
      // The regex this mirrors is `[^_]+(?:_[^_]+)*?`, so a server segment can
      // hold single underscores but never a double one — which is exactly the
      // shortest match up to the next `__`.
      return server.replacingOccurrences(of: "_", with: "-")
    }
  }
  return name.lowercased()
}

// MARK: - Predicates

/// Is this call still going?
public func callBusy(_ call: ToolCallItem) -> Bool {
  call.status == .running || call.status == .pending
}

/// Did this call fail? Both spellings are needed: an out-of-loop execution
/// failure sets only the status, and an engine can flag `is_error` on a call the
/// reducer has not settled.
public func callFailed(_ call: ToolCallItem) -> Bool {
  call.status == .failed || call.result?.isError == true
}

/// Is anything inside this Task still going? The call itself, normally — a Task
/// settles only when its subagent finishes — but a bridged or deferred child can
/// outlive it, and a pulse that stopped while a child still worked would read as
/// a hang.
public func taskBusy(_ task: ToolCallItem, _ children: [TranscriptItem]) -> Bool {
  if callBusy(task) { return true }
  return children.contains { if case .toolCall(let call) = $0 { return callBusy(call) } else { return false } }
}

/// Does a folded run colour red? **Only when its last call failed.**
///
/// It used to be `contains`, on the argument that a failure should colour the
/// block rather than fragment it. The argument was right about not fragmenting
/// and wrong about `contains`: a run is a sequence the model worked through, and
/// a failure it recovered from two calls later is how work goes. Reddening the
/// whole run for it paints a normal working session red and spends the colour
/// that should have been left for the one thing still broken.
///
/// The last call is the run's *outcome*, and an outcome is what a collapsed row
/// can honestly claim. Nothing is hidden: the failures inside are one tap away,
/// each red on its own row, and the recap counts every one. The **scrubber
/// agrees with this rule** rather than overriding it — it marks a failed call
/// only when the call is its row's outcome, which for a run is exactly this
/// one. It used to mark every member, and against a real session that meant
/// nine alarms on the rail for a transcript reddening one row.
public func runFailed(_ items: [ToolCallItem]) -> Bool {
  guard let last = items.last else { return false }
  return callFailed(last)
}

/// Does the Task row colour red? **The task's own outcome, and nothing else.**
///
/// It used to be "or any child's", which does not survive a real subagent: an
/// agent that ran a hundred calls, one of them a grep that matched nothing, came
/// back with a red line saying it had failed. It had not — and the transcript
/// said otherwise in the one colour reserved for things that need a human.
///
/// This is the call `SubagentInfo.status` already makes, and for this reason:
/// the sub-agent's **own** result, deliberately not `taskFailed`. The argument
/// there was that a nothing-matched grep must not read as a failed run beside a
/// session name; a hundred-call agent shows it must not read that way beside the
/// `Task` row either. Two surfaces, one rule.
public func taskFailed(_ task: ToolCallItem) -> Bool {
  callFailed(task)
}

// MARK: - Summaries

/// The one line a folded run of tool calls draws.
///
/// `Ran 6 tools · 3 roam-code, 2 shell, 1 read`, or `Ran N shell commands` when
/// the run is all shell — the commonest run, and the sentence people were
/// already reading. The breakdown sorts by count descending then alphabetically,
/// and that order is load-bearing rather than tidy: this string *is* the row's
/// measured height, so an unstable order would remeasure for nothing.
public func runSummary(_ items: [ToolCallItem], busy: Bool) -> String {
  let verb = busy ? "Running " : "Ran "
  let tail = busy ? "…" : ""
  let total = items.count

  var counts: [String: Int] = [:]
  var order: [String] = []
  for item in items {
    let family = toolFamily(item.name)
    if counts[family] == nil { order.append(family) }
    counts[family, default: 0] += 1
  }

  if counts.count == 1, counts["shell"] != nil {
    return "\(verb)\(total) shell command\(total == 1 ? "" : "s")\(tail)"
  }
  let breakdown =
    order
    .sorted { left, right in
      let a = counts[left]!, b = counts[right]!
      return a == b ? left < right : a > b
    }
    .map { "\(counts[$0]!) \($0)" }
    .joined(separator: ", ")
  return "\(verb)\(total) tool\(total == 1 ? "" : "s") · \(breakdown)\(tail)"
}

/// `Task(Explore · permission mode parsing)` — the agent and what it was asked
/// for, which is the only part of a subagent worth a row of its own.
public func taskLabel(_ task: ToolCallItem) -> String {
  "\(task.name)(\(taskIdentity(task)))"
}

/// The inner half of ``taskLabel(_:)`` — `Explore · permission mode parsing` —
/// without the `Task(…)` wrapper.
///
/// Split out for the sub-agent takeover's header, which names the agent it is
/// showing and has no room (or reason) to repeat the tool's own name: the whole
/// surface *is* that Task. Extracted rather than re-spelled so the header and
/// the row it was opened from cannot drift, and so both keep matching
/// ``subagentLabel(_:)``, which reads the same two fields for the sessions list.
/// The port of `taskIdentity` in `packages/ui/src/components/terminal/tool-run.ts`.
public func taskIdentity(_ task: ToolCallItem) -> String {
  let description = trimmedNonEmpty(task.input["description"]?.stringValue)
  let agent = trimmedNonEmpty(task.input["subagent_type"]?.stringValue)
  if let agent, let description { return "\(agent) · \(TermFmt.clip(description))" }
  if let agent { return agent }
  if let description { return TermFmt.clip(description) }
  return TermFmt.toolInputPreview(task.input)
}

/// **What this agent was actually asked** — the sub-agent's brief, or `nil` when
/// the engine did not give us one. The port of `taskBrief`
/// (`packages/ui/src/components/terminal/tool-run.ts`), where the reasoning is.
///
/// The short of it: the Agent SDK puts the instruction in the call's `prompt`
/// and never as a nested user message, so `subagentItems` cannot pick it up and
/// no renderer read it — a takeover you could watch without seeing what the
/// agent was told. `description` is not a fallback (the header already prints
/// it), and codex has no brief at all: its spawn message is encrypted on the
/// wire, so there the row is absent rather than empty.
public func taskBrief(_ task: ToolCallItem) -> String? {
  trimmedNonEmpty(task.input["prompt"]?.stringValue)
}

/// The collapsed `Task` row: its label and how many tools the subagent ran.
///
/// The count comes from the **absorbed children only**, never from engine-
/// structured Task output — a transcript replayed tomorrow must spell the same
/// line from the same items it holds today. "tools", not "tool calls", to match
/// `runSummary`.
public func taskSummary(_ task: ToolCallItem, _ children: [TranscriptItem]) -> String {
  let busy = taskBusy(task, children)
  let calls = children.reduce(into: 0) { total, item in
    if case .toolCall = item { total += 1 }
  }
  let label = taskLabel(task)
  if calls == 0 { return busy ? "\(label) · working…" : "\(label) · done" }
  return "\(label) · \(calls) tool\(calls == 1 ? "" : "s")\(busy ? "…" : "")"
}

private func trimmedNonEmpty(_ text: String?) -> String? {
  guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  return trimmed
}

// MARK: - The takeover strip

/// The one line above a sub-agent takeover: who this is, how it is doing, and
/// how much it has done — the port of `packages/ui`'s `SubagentStrip.tsx`,
/// minus the way back (here that is the navigation bar's).
///
/// **It claims exactly what the `Task` row it was opened from claims** — the
/// same `taskBusy` / `taskFailed` / tool count over the same items — and
/// deliberately *not* `SubagentInfo.status`. Protocol documents those two as
/// divergent on purpose, but that divergence is transcript-versus-*list* and
/// this surface **is** the transcript. The disagreement that must not exist
/// here is between a header and the rows directly beneath it.
///
/// The rollup is still allowed one job — naming an agent whose `Task` call is
/// not in the transcript (`fallbackLabel`, fed from `subagentLabel`) — because
/// a label is not content.
///
/// The status is the theme's own vocabulary: `taskSummary` already says
/// `working…` and `done` for exactly this state one row over, and a header
/// that said "running"/"completed" about the same agent would be a second
/// vocabulary for one fact. No elapsed clock, unlike the web strip: the iOS
/// reducer mirror stamps no `ts` on tool calls, and the web's own rule for an
/// absent `ts` is to draw no elapsed rather than count from the epoch.
public struct SubagentStripLine: Equatable, Sendable {
  /// `taskIdentity` of the spawning call, or the fallback when the transcript
  /// does not have it.
  public var name: String
  /// `failed` / `working…` / `done` — or nil when there is no `Task` call to
  /// read. Better silent than confidently wrong about an agent we cannot see.
  public var status: String?
  public var busy: Bool
  public var failed: Bool
  /// Tool calls in the frame — `0` draws no count, matching the web's strip.
  public var toolCount: Int
}

/// Derive the strip from the frame: the spawning call (when the transcript has
/// it), the frame's items, and the rollup's label for when it does not.
public func subagentStripLine(
  task: ToolCallItem?, items: [TranscriptItem], fallbackLabel: String
) -> SubagentStripLine {
  let busy = task.map { taskBusy($0, items) } ?? false
  let failed = task.map(taskFailed) ?? false
  let tools = items.reduce(into: 0) { total, item in
    if case .toolCall = item { total += 1 }
  }
  let status: String? = task == nil ? nil : (failed ? "failed" : busy ? "working…" : "done")
  return SubagentStripLine(
    name: task.map(taskIdentity) ?? fallbackLabel,
    status: status, busy: busy, failed: failed, toolCount: tools)
}
