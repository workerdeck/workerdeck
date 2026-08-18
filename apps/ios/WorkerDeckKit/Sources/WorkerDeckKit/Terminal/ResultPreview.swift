import Foundation

/// How much of a tool result a collapsed row shows — a port of
/// `packages/ui/src/components/terminal/result-preview.ts`.
///
/// **Two budgets, and the second one is the whole point.** Lines alone had an
/// exact blind spot: a minified JSON reply — which is every MCP tool's reply —
/// is *one* line, so a four-line slice kept all thirty thousand characters of
/// it, the hidden-line count came out zero, and the row did not even offer the
/// "+N" affordance. That was the single biggest source of transcript verbosity,
/// ahead of row count.
public enum ResultPreview {
  /// Four lines, matching the CLI.
  public static let previewLines = 4
  /// ~4 lines at a *desktop* width — the web client's constant, kept as the
  /// default so the two clients agree wherever the width does.
  ///
  /// It is a fallback, not the rule: see ``collapsed(_:cols:)``.
  public static let previewChars = 400

  public struct Collapsed: Equatable, Sendable {
    /// The lines to draw, already clipped.
    public var shown: [String]
    /// The affordance line, verbatim — returned as the exact *string* because
    /// the height calculator wraps this literal text to size the row.
    public var more: String?
  }

  /// Clip a tool result's lines to both budgets.
  ///
  /// The affordance counts **characters** when the cut happened inside a line (a
  /// one-line blob has no hidden lines to count) and **lines** otherwise —
  /// "+0 lines" under a visibly truncated row is worse than silence.
  /// Clip to both budgets, with the character budget derived from the width the
  /// row will actually be drawn at.
  ///
  /// The constant 400 encodes a desktop assumption: "about four lines" at a
  /// hundred columns. A phone is a third of that, so the same 400 characters is
  /// *thirteen* lines — a "preview" that fills the screen, which is the opposite
  /// of what the budget is for. Deriving it from `cols` keeps the promise the
  /// constant was making (four lines' worth) on any width, and reduces to the
  /// web client's number at the width the web client has.
  public static func collapsed(_ lines: [String], cols: Int) -> Collapsed {
    // Minus one: the ellipsis the clip appends is itself a character, and a
    // budget of exactly four lines' worth would spill it onto a fifth line
    // holding nothing else.
    collapsed(lines, chars: cols > 0 ? previewLines * cols - 1 : previewChars)
  }

  public static func collapsed(_ lines: [String], chars budget: Int = previewChars) -> Collapsed {
    var shown: [String] = []
    var chars = 0
    var cutInsideLine = false

    for line in lines.prefix(previewLines) {
      if shown.isEmpty && line.count > budget {
        shown.append(String(line.prefix(budget)) + "…")
        chars = budget
        cutInsideLine = true
        break
      }
      if !shown.isEmpty && chars + line.count > budget { break }
      shown.append(line)
      chars += line.count + 1  // + 1 for the newline that rejoins them
    }

    if cutInsideLine {
      let whole = lines.joined(separator: "\n").count
      return Collapsed(shown: shown, more: "… +\(TermFmt.grouped(whole - chars)) chars")
    }
    let hidden = lines.count - shown.count
    return Collapsed(
      shown: shown, more: hidden > 0 ? "… +\(hidden) line\(hidden == 1 ? "" : "s")" : nil)
  }

  /// The budget an **expanded** row opens at. A hundred-thousand-character
  /// result lands in *one* virtual row, and a virtualizer recycles rows, not
  /// what is inside one — so this is a layout guard, not a preference.
  ///
  /// **`full` is deliberately not capped**, and that decision got more expensive
  /// when the renderer became one TextKit run per row: the third state puts the
  /// whole result into a single text container, and a very large one is a
  /// visible hitch on that press. It stays uncapped anyway, because the
  /// affordance *names the number* — "show all 9,828 chars" that then showed
  /// 20,000 of them would be a lie, and this is a transcript that never elides.
  /// What the cap would have bought is already bought twice over by the two
  /// states below it: the collapsed preview and this budget are what bound the
  /// **scrolling** path, and nothing enters `full` except a deliberate press.
  public static let expandedChars = 2000

  /// Whole lines only, and never zero of them: a first line longer than the
  /// budget is still the only thing there is to show.
  public static func clipToChars(_ lines: [String], max: Int = expandedChars) -> [String] {
    var out: [String] = []
    var chars = 0
    for line in lines {
      if !out.isEmpty && chars + line.count > max { break }
      out.append(line)
      chars += line.count + 1
    }
    return out
  }
}
