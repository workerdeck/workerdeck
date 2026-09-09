import Foundation

/// What happened while the reader was away, counted.
///
/// A port of `packages/react/src/lib/recap.ts`, and the counting is the whole
/// contract: the recap is **derived from the transcript, never written by the
/// model**. A prose summary would spend a turn on something nobody asked for,
/// and would be worst in the case that matters most — a session that failed
/// unattended.
public struct RecapSummary: Equatable, Sendable {
  public var turns: Int
  public var replies: Int
  public var tools: Int
  public var toolNames: [String]
  public var files: Int
  public var errors: Int
  public var pending: Int

  public var any: Bool { turns + replies + tools + files + errors + pending > 0 }
}

/// The boundary is clamped, never rejected: a transcript can shrink (a `/clear`,
/// a compaction) between the mark being taken and this being asked.
public func summarizeSince(items: [TranscriptItem], from index: Int, pendingApprovals: Int = 0)
  -> RecapSummary
{
  let start = max(0, min(index, items.count))
  var toolCounts: [String: Int] = [:]
  var turns = 0
  var replies = 0
  var tools = 0
  var files = 0
  var errors = 0

  for item in items[start...] {
    switch item {
    case .turnResult(_, _, let isError, _, _, _):
      turns += 1
      if isError { errors += 1 }
    case .assistantText:
      replies += 1
    case .toolCall(let call):
      tools += 1
      toolCounts[call.name, default: 0] += 1
      if call.status == .failed || call.result?.isError == true { errors += 1 }
    case .fileDelivered:
      files += 1
    case .notice(_, let level, _):
      if level == .error { errors += 1 }
    default:
      break
    }
  }

  // Swift's sort is not stable, so the name tiebreak is explicit — the same
  // reason the sessions list carries one.
  let toolNames =
    toolCounts
    .sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
    .map(\.key)
  return RecapSummary(
    turns: turns, replies: replies, tools: tools, toolNames: toolNames, files: files,
    errors: errors, pending: pendingApprovals)
}

/// The one line the seam draws. `nil` when nothing happened — there is then no
/// boundary worth marking, and a row saying so would be the noise this feature
/// is supposed to save the reader.
public func recapLine(_ summary: RecapSummary) -> String? {
  guard summary.any else { return nil }
  var parts: [String] = []
  if summary.turns > 0 {
    parts.append(plural(summary.turns, "turn"))
  } else if summary.replies > 0 {
    parts.append(plural(summary.replies, "reply", "replies"))
  }
  if summary.tools > 0 {
    let named = summary.toolNames.prefix(3).joined(separator: ", ")
    let rest = summary.toolNames.count - 3
    let detail = named.isEmpty ? "" : " (\(named)\(rest > 0 ? ", +\(rest)" : ""))"
    parts.append("\(plural(summary.tools, "tool call"))\(detail)")
  }
  if summary.files > 0 {
    parts.append(plural(summary.files, "file"))
  }
  if summary.errors > 0 {
    parts.append(plural(summary.errors, "error"))
  }
  if summary.pending > 0 {
    parts.append("\(plural(summary.pending, "approval")) waiting")
  }
  return parts.joined(separator: " · ")
}

private func plural(_ count: Int, _ one: String, _ many: String? = nil) -> String {
  "\(count) \(count == 1 ? one : (many ?? "\(one)s"))"
}
