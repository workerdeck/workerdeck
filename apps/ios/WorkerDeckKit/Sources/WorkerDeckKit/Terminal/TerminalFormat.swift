import Foundation

/// Formatters and tool predicates for the terminal transcript — a port of the
/// pieces of `packages/ui/src/lib/format.ts` and `lib/tool-icon.ts` that the
/// theme draws with.
///
/// These are deliberately **not** `Fmt` (the app's card-side formatters, which
/// spell a cost "$0.0142" and a duration "1m 04s"). In the terminal theme the
/// rendered string *is* the row's measured height, so a second spelling is a
/// second height: whatever the calculator wraps must be character-for-character
/// what the row draws, and what the row draws must match the web client or the
/// two transcripts disagree about the same session.
public enum TermFmt {
  /// `COMPACTION_TEXT` (`packages/ui/src/lib/format.ts`), copied because there
  /// is no module the two sides can share. `TerminalTextTests` pins it.
  public static let compaction = "context compacted · earlier turns summarised to fit the window"

  /// `formatCost` — `nil`/NaN reads "—" rather than "$0.00", because "we do not
  /// know" and "it was free" are different facts.
  public static func cost(_ usd: Double?) -> String {
    guard let usd, !usd.isNaN else { return "—" }
    if usd == 0 { return "$0.00" }
    if usd < 0.01 { return "<$0.01" }
    return String(format: "$%.2f", usd)
  }

  /// `formatDuration` — "820ms" / "3.2s" / "1m 4s".
  public static func duration(ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    let seconds = ms / 1000
    if seconds < 60 { return String(format: "%.1fs", seconds) }
    let minutes = Int(seconds / 60)
    return "\(minutes)m \(Int((seconds.truncatingRemainder(dividingBy: 60)).rounded()))s"
  }

  /// `formatBytes` — binary thresholds, decimal-ish labels, exactly as the web
  /// client spells them.
  public static func bytes(_ count: Int) -> String {
    let value = Double(count)
    if value >= 1024 * 1024 { return String(format: "%.1f MB", value / (1024 * 1024)) }
    if value >= 1024 { return String(format: "%.1f KB", value / 1024) }
    return "\(count) B"
  }

  /// `formatTokens` — 850 → "850", 359_000 → "359.0k".
  public static func tokens(_ count: Int) -> String {
    let value = Double(count)
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 1000 { return String(format: "%.1fk", value / 1000) }
    return "\(count)"
  }

  /// Thousands separators for the "+N chars" affordance, which the web client
  /// gets from `Number.toLocaleString()`. Fixed to the POSIX grouping rather
  /// than the device locale on purpose: a locale-dependent string is a
  /// locale-dependent *height*, and the row is measured before it is drawn.
  public static func grouped(_ count: Int) -> String {
    let digits = String(abs(count))
    var out = ""
    for (offset, character) in digits.enumerated() {
      if offset > 0 && (digits.count - offset) % 3 == 0 { out.append(",") }
      out.append(character)
    }
    return (count < 0 ? "-" : "") + out
  }

  /// `clip` — the theme's one truncation rule: keep `max - 1` and spend the last
  /// cell on the ellipsis, so a clipped string is never wider than its budget.
  public static func clip(_ text: String, max: Int = 80) -> String {
    guard text.count > max, max > 0 else { return text }
    return String(text.prefix(max - 1)) + "…"
  }

  /// `toolInputPreview` — the one-line summary of a tool's input. First present
  /// of the seven well-known keys wins; anything else falls back to compact
  /// JSON.
  public static func toolInputPreview(_ input: JSONValue?, max: Int = 80) -> String {
    guard let input, input != .null else { return "" }
    if let object = input.objectValue {
      for key in ["command", "file_path", "path", "url", "pattern", "query", "description"] {
        guard let value = object[key] else { continue }
        if let text = value.stringValue { return clip(text, max: max) }
        break  // present but not a string: JS reads the *first present* key, then gives up
      }
    }
    return clip(jsonText(input), max: max)
  }

  /// Compact JSON, keys sorted. `JSON.stringify` emits insertion order, which a
  /// decoded Swift dictionary does not preserve and cannot recover — so this
  /// picks the one order that is stable across runs rather than one that is
  /// merely usually right. It is a fallback path (every first-party tool hits a
  /// named key above) and it is measured with the same function that draws it.
  public static func jsonText(_ value: JSONValue) -> String {
    switch value {
    case .null: return "null"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number):
      if number == number.rounded() && abs(number) < 1e15 { return String(Int64(number)) }
      return String(number)
    case .string(let text): return quoted(text)
    case .array(let items): return "[" + items.map(jsonText).joined(separator: ",") + "]"
    case .object(let fields):
      let body = fields.keys.sorted().map { "\(quoted($0)):\(jsonText(fields[$0]!))" }
      return "{" + body.joined(separator: ",") + "}"
    }
  }

  private static func quoted(_ text: String) -> String {
    var out = "\""
    for character in text.unicodeScalars {
      switch character {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if character.value < 0x20 {
          out += String(format: "\\u%04x", character.value)
        } else {
          out.unicodeScalars.append(character)
        }
      }
    }
    return out + "\""
  }
}

/// Does this tool run a shell command? The terminal theme folds a run that is
/// *all* shell into "Ran N shell commands", the sentence people were already
/// reading. `BashOutput`/`KillShell` are excluded on purpose — they manage a
/// background shell rather than run something, and folding them in inflates the
/// count.
public func isShellTool(_ name: String) -> Bool {
  name == "Bash" || name == "CodexCommand"
}

/// Does this tool *change* the workspace? Worth its own colour: skimming a run,
/// "what did it edit" is a different question from "what did it look at". An MCP
/// tool is unknowable from its name, so it reads neutral rather than guessed.
public func isMutatingTool(_ name: String) -> Bool {
  switch name {
  case "Write", "Edit", "MultiEdit", "NotebookEdit", "Update", "CodexFileChange": return true
  default: return false
  }
}
