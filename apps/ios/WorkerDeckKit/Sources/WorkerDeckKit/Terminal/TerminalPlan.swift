import Foundation

/// What a row draws, line by line — the port of
/// `packages/ui/src/components/terminal/height.ts`, turned inside out.
///
/// On the web the browser wraps the text and `height.ts` *predicts* how many
/// lines that will be; the two agree to 99–100% on real content and the
/// calculator flags the cases it cannot know. On iOS we can do better than
/// agree: the planner wraps the text, the renderer draws the lines the planner
/// returned, and a row's height is by definition `lines.count × metrics.line`.
/// There is no prediction to be wrong.
///
/// That is why this file produces a *plan* rather than a number. The number is
/// `plan.count`; the renderer is handed the same array.
///
/// Two invariants carried over from the web client, both still load-bearing:
///
/// 1. **Only the collapsed state is ever planned.** An expanded row is by
///    definition on screen and can be measured for real. This is what lets a
///    `Task` row be sized as one wrapped summary line.
/// 2. **The strings are the heights.** Every summary, preview and affordance
///    string comes from `ToolRun.swift` / `ResultPreview.swift`, never from a
///    view — a second spelling would be a second height.

// MARK: - Metrics

/// The character cell, in whole points.
///
/// `cell` is **measured**, never derived from `fontSize`: a 13pt monospace face
/// advances about 7.8pt, not 13 × 0.6. `line` and `cell` must be whole points —
/// 1.5 × 13 = 19.5 puts every second row on a half-pixel, which softens the text
/// and seams the diff bands.
public struct TerminalMetrics: Equatable, Sendable {
  public var cell: CGFloat
  public var line: CGFloat
  /// The content width available to a row, gutter included.
  public var width: CGFloat
  public var fontSize: CGFloat

  public init(cell: CGFloat, line: CGFloat, width: CGFloat, fontSize: CGFloat) {
    self.cell = cell
    self.line = line
    self.width = width
    self.fontSize = fontSize
  }

  /// How many character columns fit a body, given what the gutter and indent
  /// have already spent.
  ///
  /// The epsilon is not superstition: layout rounds, and an exactly-N-cell body
  /// otherwise floors to N − 1 and wraps a line that fits.
  public func columns(gutter: Int, indent: Int = 0, extra: CGFloat = 0) -> Int {
    let body = width - extra - CGFloat(gutter + indent) * cell
    return max(0, Int((body / cell + 1e-4).rounded(.down)))
  }
}

// MARK: - Tones

/// The palette, by meaning rather than by colour — the views map these to the
/// theme's tokens. Named for what they *say*, so a row asks for `dim` (meta,
/// tool output) and never for a grey.
public enum TermTone: String, Equatable, Sendable {
  case fg, bright, dim, faint, mark, blue, green, red, yellow, magenta
  case diffAdd, diffRemove, diffContext, diffNumber
}

/// What kind of ground a line sits on.
public enum TermBand: String, Equatable, Sendable {
  case none
  /// The prompt row's wash.
  case user
  /// Code and tool output.
  case output
  case diffAdd
  case diffRemove
}

// MARK: - A planned line

/// Exactly one rendered line: the gutter cell's content and the body that sits
/// beside it, already wrapped to the column count.
///
/// The gutter is its own column, which is what gives every wrapped line its
/// hanging indent for free — the body cannot flow under the marker.
public struct TermLine: Equatable, Sendable {
  /// Gutter content, pre-padded to `columns` cells by the planner. Empty means
  /// an unmarked row, which still reserves the column so text stays aligned.
  public var gutter: String
  public var gutterTone: TermTone
  /// The body, one rendered line's worth.
  public var text: String
  /// Inline-styled body, when the block had inline markdown. When set, the view
  /// draws this and `text` is what it was measured as — the same characters.
  public var attributed: AttributedString?
  public var tone: TermTone
  /// Gutter width in cells. 2 by default; a numbered diff or a numbered choice
  /// list widens it so every body starts on one column.
  public var columns: Int
  /// Indent levels, in cells.
  public var indent: Int
  public var band: TermBand
  public var bold: Bool
  public var italic: Bool
  /// Drawn one level in behind a rule, for a subagent's own rows.
  public var nested: Bool
  /// The gutter glyph animates through the brand pulse. Never affects height —
  /// every frame is one cell — so it rides the plan rather than forcing the
  /// view to re-derive which rows are working.
  public var pulsing: Bool

  public init(
    gutter: String = "", gutterTone: TermTone = .dim, text: String,
    attributed: AttributedString? = nil, tone: TermTone = .fg, columns: Int = 2, indent: Int = 0,
    band: TermBand = .none, bold: Bool = false, italic: Bool = false, nested: Bool = false,
    pulsing: Bool = false
  ) {
    self.gutter = gutter
    self.gutterTone = gutterTone
    self.text = text
    self.attributed = attributed
    self.tone = tone
    self.columns = columns
    self.indent = indent
    self.band = band
    self.bold = bold
    self.italic = italic
    self.nested = nested
    self.pulsing = pulsing
  }
}

/// The gutter glyph vocabulary — the CLI's own.
public enum TermGlyph {
  /// What you typed. Shared with the composer: two spellings would put the caret
  /// a glyph off the column every prompt row sits on.
  public static let prompt = "❯"
  /// What the model said, or a tool it called.
  public static let bullet = "●"
  /// That tool's output, one level in.
  public static let output = "⎿"
  public static let thinking = "✻"
  public static let notice = "!"
  public static let file = "⤓"
  /// The catch-up seam.
  public static let recap = "※"
  /// Between two diff hunks.
  public static let hunkGap = "⋮"

  /// The working marker: the brand mark's own pulse, `⋄ ◇ ◈ ◆` at 150ms — one
  /// cycle is 0.6s, the clock in `icon-loading.svg`. It rests on `◆` under
  /// Reduce Motion, which is free: the last frame *is* the mark.
  public static let pulseFrames = ["⋄", "◇", "◈", "◆"]
  public static let pulseRest = "◆"
  public static let pulseInterval: TimeInterval = 0.15
}
