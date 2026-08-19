import WorkerDeckKit
import Foundation

extension JSONValue {
  /// Pretty, key-sorted JSON for the expanded tool-call input. Sorted because the
  /// decoded representation is an unordered dictionary — insertion order is gone
  /// by the time the app sees it, so stable is the best available.
  var prettyJSON: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "" }
    return String(decoding: data, as: UTF8.self)
  }

  /// One-line summary of a tool input for a collapsed card.
  ///
  /// Per-tool preferred keys first (Bash → `command`, Read/Edit/Write →
  /// `file_path`, …), then the first non-empty string field, then compact JSON.
  /// Never nil for a non-empty input — a card with no summary reads as broken.
  func toolInputSummary(toolName: String) -> String? {
    guard let object = objectValue else {
      if case .null = self { return nil }
      return Fmt.oneLine(prettyJSON)
    }
    guard !object.isEmpty else { return nil }
    for key in Self.preferredKeys(for: toolName) {
      if let value = object[key]?.stringValue, !value.isEmpty {
        return Fmt.oneLine(value)
      }
    }
    for key in object.keys.sorted() {
      if let value = object[key]?.stringValue, !value.isEmpty {
        return Fmt.oneLine(value)
      }
    }
    return Fmt.oneLine(prettyJSON)
  }

  /// The same field `toolInputSummary` picks, **whole** — no 140-character cap
  /// and newlines kept.
  ///
  /// The two exist because they answer different questions. A collapsed
  /// transcript card is a row in a list and wants one flattened line; an
  /// *approval* is a decision, and the string it clips is the command about to
  /// run. A Bash approval reading `... | tee _docs/measurements/attach-parts-$(d…`
  /// hides the half of the pipeline that touches the filesystem, which is the
  /// half worth approving. Nothing bounds the height here because the prompt's
  /// body scrolls (`PromptBodyScroll`) — that is what made showing it whole
  /// affordable.
  func toolInputSubject(toolName: String) -> String? {
    guard let object = objectValue else {
      if case .null = self { return nil }
      return prettyJSON
    }
    guard !object.isEmpty else { return nil }
    for key in Self.preferredKeys(for: toolName) {
      if let value = object[key]?.stringValue, !value.isEmpty { return value }
    }
    for key in object.keys.sorted() {
      if let value = object[key]?.stringValue, !value.isEmpty { return value }
    }
    return prettyJSON
  }

  private static func preferredKeys(for toolName: String) -> [String] {
    switch toolName {
    case "Bash", "BashOutput", "KillShell":
      return ["command", "description", "shell_id"]
    case "Read", "Write", "Edit", "MultiEdit", "NotebookEdit":
      return ["file_path", "notebook_path", "path"]
    case "Glob", "Grep":
      return ["pattern", "query", "path"]
    case "WebFetch", "WebSearch":
      return ["url", "query", "prompt"]
    case "Task", "Agent":
      return ["description", "subagent_type", "prompt"]
    case "TodoWrite":
      return ["todos"]
    case "Skill":
      return ["skill", "command"]
    default:
      return ["path", "file_path", "command", "query", "pattern", "url", "description", "name"]
    }
  }
}

/// SF Symbol per tool, with a generic fallback. Names only — no bundled assets.
enum ToolIcon {
  static func symbol(for toolName: String) -> String {
    switch toolName {
    case "Bash", "BashOutput", "KillShell": return "terminal"
    case "Read": return "doc.text"
    case "Write": return "square.and.pencil"
    case "Edit", "MultiEdit", "NotebookEdit": return "pencil.line"
    case "Glob": return "folder.badge.questionmark"
    case "Grep": return "magnifyingglass"
    case "WebFetch": return "arrow.down.circle"
    case "WebSearch": return "globe"
    case "Task", "Agent": return "person.2"
    case "TodoWrite": return "checklist"
    case "Skill": return "sparkles"
    case "AskUserQuestion": return "questionmark.bubble"
    // The codex engine's own tool names (see its runner's item mapping).
    case "CodexCommand": return "terminal"
    case "CodexFileChange": return "plusminus"
    case "CodexWebSearch": return "globe"
    case "CodexImageGeneration", "CodexImageView": return "photo"
    default:
      return toolName.hasPrefix("mcp__") ? "puzzlepiece.extension" : "wrench.and.screwdriver"
    }
  }

  /// Does this call *change* something on the host?
  ///
  /// Only used for colour, and only in `lines`: skimming a finished run, "what
  /// did it edit" is the question you come back to, so a settled write earns the
  /// one green marker in the column. Mirrors the web's `isMutatingTool`.
  static func isMutating(_ toolName: String) -> Bool {
    switch toolName {
    case "Write", "Edit", "MultiEdit", "NotebookEdit", "CodexFileChange": return true
    default: return false
    }
  }
}
