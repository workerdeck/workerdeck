import Foundation

// The port of `packages/ui/src/components/terminal/live-tool.ts`.
public enum LiveTool {
  public static let tailLineCount = 5
  public static let elapsedAfterMs: Double = 5000
  public static let elapsedWidest = " · 59m 59s"

  private static let backgroundable: Set<String> = ["Bash", "Task", "Agent"]

  public static func tailLines(_ call: ToolCallItem) -> [String] {
    guard let tail = call.liveTail, !tail.isEmpty, callBusy(call) else { return [] }
    return Array(tail.components(separatedBy: "\n").suffix(tailLineCount))
  }

  public static func elapsedLabel(startedAt: Double?, now: Double) -> String? {
    guard let startedAt, now - startedAt >= elapsedAfterMs else { return nil }
    return TermFmt.duration(ms: ((now - startedAt) / 1000).rounded(.down) * 1000)
  }

  public static func runStartedAt(_ calls: [ToolCallItem]) -> Double? {
    calls.filter(callBusy).compactMap(\.ts).min()
  }

  public static func runTailLines(_ calls: [ToolCallItem]) -> [String] {
    for call in calls.reversed() {
      let lines = tailLines(call)
      if !lines.isEmpty { return lines }
    }
    return []
  }

  public static func canBackground(_ call: ToolCallItem) -> Bool {
    backgroundable.contains(call.name) && call.parentToolUseId == nil && callBusy(call)
  }

  // Walks back only through the current turn: a running call is never older than the last prompt.
  public static func hasBackgroundable(_ items: [TranscriptItem]) -> Bool {
    for item in items.reversed() {
      switch item {
      case .user(_, _, _, nil, _):
        return false
      case .toolCall(let call) where canBackground(call):
        return true
      default:
        continue
      }
    }
    return false
  }

  // The cell the elapsed label starts at on its line: after the drawn text, hanging spaces excluded.
  public static func elapsedColumn(_ line: TermLine) -> Int {
    var text = Substring(line.text)
    while text.last == " " { text = text.dropLast() }
    return text.reduce(0) { $0 + TerminalCells.clusterCells($1).cells }
  }

  // The label a line carrying `elapsedSince` draws: the leading separator only when text precedes it.
  public static func elapsedText(_ line: TermLine, now: Double) -> String? {
    guard let label = elapsedLabel(startedAt: line.elapsedSince, now: now) else { return nil }
    return elapsedColumn(line) == 0 ? label : " · \(label)"
  }
}

extension TranscriptRow {
  // The running top-level Bash or subagent call this row is drawn as, when it can be moved to the background.
  public var backgroundableCallId: String? {
    guard case .block(let block) = self else { return nil }
    switch block {
    case .item(let leaf):
      guard case .toolCall(let call) = leaf.item, LiveTool.canBackground(call) else { return nil }
      return call.id
    case .run(let leaf):
      guard leaf.run.count == 1, let call = leaf.run.first, LiveTool.canBackground(call) else {
        return nil
      }
      return call.id
    case .task(let leaf):
      return LiveTool.canBackground(leaf.task) ? leaf.task.id : nil
    }
  }
}
