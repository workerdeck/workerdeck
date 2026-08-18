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

/// Did anything inside this Task fail? Colours the row; never splits it.
public func taskFailed(_ task: ToolCallItem, _ children: [TranscriptItem]) -> Bool {
  if callFailed(task) { return true }
  return children.contains { if case .toolCall(let call) = $0 { return callFailed(call) } else { return false } }
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
  let description = trimmedNonEmpty(task.input["description"]?.stringValue)
  let agent = trimmedNonEmpty(task.input["subagent_type"]?.stringValue)
  let inner: String
  if let agent, let description {
    inner = "\(agent) · \(TermFmt.clip(description))"
  } else if let agent {
    inner = agent
  } else if let description {
    inner = TermFmt.clip(description)
  } else {
    inner = TermFmt.toolInputPreview(task.input)
  }
  return "\(task.name)(\(inner))"
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
