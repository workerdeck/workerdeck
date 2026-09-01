import Foundation

/// The `TodoWrite` checklist — a port of
/// `packages/ui/src/components/terminal/todos.ts`.
///
/// `TodoWrite`'s result prose is "Todos have been modified successfully", which
/// tells the reader nothing the checklist itself does not say better. So the
/// call's *input* becomes the row: the header's parenthetical counts what is
/// done, and the block underneath draws the list in place of the result
/// preview.
public enum TerminalTodos {
  /// How many entries a collapsed checklist draws before it starts counting.
  ///
  /// Eight is a row budget, not a data limit: a todo list is usually five to ten
  /// items, and a plan long enough to overflow this is one the reader will open
  /// rather than skim.
  public static let previewTodos = 8

  public enum Status: String, Equatable, Sendable {
    case pending
    case inProgress = "in_progress"
    case completed
  }

  public struct Entry: Equatable, Sendable {
    public var status: Status
    public var text: String

    public init(status: Status, text: String) {
      self.status = status
      self.text = text
    }
  }

  public struct Preview: Equatable, Sendable {
    /// The header's parenthetical — what `toolInputPreview` would otherwise say.
    public var summary: String
    public var shown: [Entry]
    /// The overflow line, verbatim, because the planner wraps this exact string.
    public var more: String?
  }

  /// One cell each, pinned by test. A two-cell glyph would put every checklist
  /// line one column out of step with the grid the whole theme is measured on.
  static func glyph(_ status: Status) -> String {
    switch status {
    case .pending: return "☐"
    case .inProgress: return "◐"
    case .completed: return "☒"
    }
  }

  static func tone(_ status: Status) -> TermTone {
    switch status {
    case .pending: return .dim
    case .inProgress: return .blue
    case .completed: return .faint
    }
  }

  private static func entry(_ value: JSONValue) -> Entry? {
    guard let object = value.objectValue else { return nil }
    guard let raw = object["status"]?.stringValue, let status = Status(rawValue: raw) else {
      return nil
    }
    let content = object["content"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let content, !content.isEmpty else { return nil }
    let active = object["activeForm"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
    let text = status == .inProgress && !(active ?? "").isEmpty ? active! : content
    return Entry(status: status, text: text)
  }

  /// Whole-or-nothing: a malformed entry — which is what a streaming, partially
  /// delivered input looks like — falls back to the generic preview rather than
  /// a half-drawn checklist.
  public static func parse(_ input: JSONValue?) -> [Entry]? {
    guard let items = input?.objectValue?["todos"]?.arrayValue, !items.isEmpty else { return nil }
    var out: [Entry] = []
    out.reserveCapacity(items.count)
    for value in items {
      guard let entry = entry(value) else { return nil }
      out.append(entry)
    }
    return out
  }

  public static func preview(name: String, input: JSONValue?) -> Preview? {
    guard name == "TodoWrite", let todos = parse(input) else { return nil }
    let done = todos.reduce(0) { $0 + ($1.status == .completed ? 1 : 0) }
    let shown = Array(todos.prefix(previewTodos))
    let hidden = todos.count - shown.count
    return Preview(
      summary: "\(done)/\(todos.count) done", shown: shown,
      more: hidden > 0 ? "… +\(hidden) more" : nil)
  }

  /// Height and render both draw this exact string — the planner wraps what the
  /// renderer paints, so there is one spelling of a checklist line and not two.
  public static func line(_ entry: Entry) -> String {
    "\(glyph(entry.status)) \(entry.text)"
  }
}
