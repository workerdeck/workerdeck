import Foundation

/// The `$` row's strings - a port of
/// `packages/ui/src/components/terminal/shell-row.ts`.
///
/// Every string a shell row draws comes from here, which on this renderer is
/// also what makes it a *height*: the planner wraps exactly these characters.
/// The web row and this one say the same words about the same record, because
/// "exit 1" and "failed" would be two answers to what the gateway reported once.
public enum TerminalShell {
  /// The command's marker, and the composer's trigger.
  public static let glyph = "$"
  /// The kill affordance, on the header of a running shell.
  public static let killGlyph = "✕"
  /// What an expanded row will draw before it starts counting what it clipped -
  /// the same budget a tool result's expansion gets, and for the same reason: an
  /// expanded row is one virtual row, however many lines are inside it.
  public static let expandChars = 100_000
  public static let missing = "output expired or not tracked by this gateway"

  /// What the first character typed into an empty composer means.
  public enum ComposerTrigger: Equatable, Sendable {
    /// `$`: enter shell mode, and swallow the character - it is the marker the
    /// row draws, never part of the command.
    case enter
    /// Backspace on an empty shell prompt: leave the mode and leave the field
    /// empty. The deliberate exit (Escape on a keyboard, the gutter `$` on a
    /// phone) is the other one, and it puts the literal `$` back - see
    /// ``exitDraft(_:)``.
    case leave
    /// Anything else, `!` included: ordinary text, so `!ls` is a message that
    /// says `!ls`.
    case pass
  }

  public static func composerTrigger(
    character: String, isShellMode: Bool, canRunShell: Bool
  ) -> ComposerTrigger {
    if isShellMode { return character.isEmpty ? .leave : .pass }
    guard canRunShell, character == glyph else { return .pass }
    return .enter
  }

  /// What the composer holds after a deliberate exit: the swallowed `$` comes
  /// back, so leaving the mode never silently eats a character the reader typed.
  public static func exitDraft(_ draft: String) -> String { glyph + draft }

  public static func label(_ item: ShellItem) -> String {
    let label = item.shell.label
    if !label.isEmpty { return label }
    return item.shell.command.components(separatedBy: "\n").first ?? ""
  }

  /// What the record says happened, in the words the reader needs.
  ///
  /// The two gateway-lifecycle reasons are spelled out rather than collapsed
  /// into "killed": a gateway that stopped cleanly really did kill the process,
  /// and one that was restarted underneath it did **not** - so the copy for that
  /// case says the process may still be running, which is the honest reading of
  /// a record reconciled from a stale generation.
  public static func statusText(_ item: ShellItem) -> String {
    let shell = item.shell
    if shell.status == .running { return "running" }
    if let code = shell.exitCode { return code == 0 ? "exit 0" : "exit \(code)" }
    switch shell.endReason {
    case .killed: return "killed"
    case .timeout: return "timed out"
    case .serverStopped: return "killed: the gateway stopped"
    case .serverRestarted:
      return "ended: the gateway restarted, the process may still be running"
    case .spawnFailed: return "failed to start"
    default: return "ended"
    }
  }

  public static func failed(_ item: ShellItem) -> Bool {
    item.shell.status == .exited && item.shell.exitCode != 0
  }

  public static func headerText(_ item: ShellItem) -> String {
    let kill = item.shell.status == .running ? " \(killGlyph)" : ""
    return "\(label(item)) · \(statusText(item))\(kill)"
  }

  public static func bodyLines(_ item: ShellItem, open: Bool) -> [String] {
    let source = open ? (item.expanded ?? item.text) : item.text
    if source.isEmpty { return [] }
    let lines = source.components(separatedBy: "\n")
    guard open else { return lines }
    var kept: [String] = []
    var chars = 0
    for line in lines {
      if !kept.isEmpty, chars + line.count > expandChars { break }
      kept.append(line)
      chars += line.count + 1
    }
    return kept
  }

  /// The row's one affordance line: what expanding will fetch, what it clipped,
  /// or why it cannot.
  public static func footerText(_ item: ShellItem, open: Bool, shown: Int) -> String? {
    if item.missing { return missing }
    guard open else { return item.truncated ? "… more output - expand to fetch it" : nil }
    if let expanded = item.expanded {
      let total = expanded.components(separatedBy: "\n").count
      if total > shown { return "… +\(total - shown) lines not shown" }
      return nil
    }
    return item.truncated ? "… fetching the full output" : nil
  }
}
