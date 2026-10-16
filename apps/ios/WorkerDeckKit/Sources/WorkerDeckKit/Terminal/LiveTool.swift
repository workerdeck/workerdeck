import Foundation

// The elapsed label a running tool's line draws, the port of `packages/ui/src/components/terminal/live-tool.ts`.
public enum LiveTool {
  public static let elapsedAfterMs: Double = 5000

  public static func elapsedLabel(startedAt: Double?, now: Double) -> String? {
    guard let startedAt, now - startedAt >= elapsedAfterMs else { return nil }
    return TermFmt.duration(ms: ((now - startedAt) / 1000).rounded(.down) * 1000)
  }

  // The cell the elapsed label starts at on its line: after the drawn text, hanging spaces excluded.
  public static func elapsedColumn(_ line: TermLine) -> Int {
    var text = Substring(line.text)
    while text.last == " " { text = text.dropLast() }
    return text.reduce(0) { $0 + TerminalCells.clusterCells($1) }
  }

  // The label a line carrying `elapsedSince` draws: the leading separator only when text precedes it.
  public static func elapsedText(_ line: TermLine, now: Double) -> String? {
    guard let label = elapsedLabel(startedAt: line.elapsedSince, now: now) else { return nil }
    return elapsedColumn(line) == 0 ? label : " · \(label)"
  }
}
