import Foundation

/// The value side of ``VTScreen``: what one cell holds, what one line draws
/// as, and the keys a view turns into PTY input.
///
/// Everything here is a plain value so a view can copy a line out of the
/// screen and draw it off the main actor if it ever wants to; the screen itself
/// is the only thing that mutates.

public enum VTColor: Equatable, Hashable, Sendable {
  case `default`
  /// The 256-colour cube: 0...7 the base palette, 8...15 bright, 16...231 the
  /// 6x6x6 cube, 232...255 the greys. The view owns the palette.
  case indexed(UInt8)
  case rgb(UInt8, UInt8, UInt8)
}

public struct VTStyle: Equatable, Hashable, Sendable {
  public var fg: VTColor
  public var bg: VTColor
  public var bold: Bool
  public var dim: Bool
  public var italic: Bool
  public var underline: Bool
  public var inverse: Bool
  public var strikethrough: Bool
  /// SGR 8 (conceal): the run's text is not drawn, its background still is.
  public var hidden: Bool

  public init(
    fg: VTColor = .default, bg: VTColor = .default, bold: Bool = false, dim: Bool = false,
    italic: Bool = false, underline: Bool = false, inverse: Bool = false, strikethrough: Bool = false,
    hidden: Bool = false
  ) {
    self.fg = fg
    self.bg = bg
    self.bold = bold
    self.dim = dim
    self.italic = italic
    self.underline = underline
    self.inverse = inverse
    self.strikethrough = strikethrough
    self.hidden = hidden
  }

  public static let `default` = VTStyle()

  /// Whether a blank cell in this style still draws something: a background,
  /// an inverse block, an underline. A blank that does not is what the line
  /// views trim from the end.
  public var paintsBlank: Bool {
    bg != .default || inverse || underline || strikethrough
  }
}

/// One grid cell. A wide character (CJK, most emoji) occupies two cells: the
/// first carries the text, the second is a continuation whose `text` is nil.
public struct VTCell: Equatable, Sendable {
  /// nil or a space for blank. Combining marks ride on the base character's
  /// cell, so this is one grapheme cluster, never more.
  public var text: Character?
  public var style: VTStyle
  public var isContinuation: Bool

  public init(text: Character? = nil, style: VTStyle = .default, isContinuation: Bool = false) {
    self.text = text
    self.style = style
    self.isContinuation = isContinuation
  }

  public static let blank = VTCell()

  public var isBlank: Bool {
    !isContinuation && (text == nil || text == " ")
  }
}

public struct VTLine: Equatable, Sendable {
  public var cells: [VTCell]

  public init(cells: [VTCell]) {
    self.cells = cells
  }

  /// A run-length view for drawing: consecutive cells sharing a style, as
  /// (text, style, columns) with trailing blanks trimmed. This is what the view
  /// actually draws, and building it here keeps the renderer honest about what
  /// one attributed run is. `columns` is the cells the run covers, which is
  /// not `text.count`: a wide glyph is one character over two cells. Every
  /// wide glyph is a run of its own, so the view places it at its column and
  /// never depends on a fallback CJK or emoji face advancing exactly two cells
  /// inside a longer string. The next run starts at the sum of the columns
  /// before it, never at a character count.
  public func runs() -> [(text: String, style: VTStyle, columns: Int)] {
    let end = drawnEnd
    var runs: [(text: String, style: VTStyle, columns: Int)] = []
    var text = ""
    var style = VTStyle.default
    var columns = 0
    var index = 0
    while index < end {
      let cell = cells[index]
      if index + 1 < end, cells[index + 1].isContinuation {
        if columns > 0 {
          runs.append((text, style, columns))
          text = ""
          columns = 0
        }
        var span = 1
        while index + span < end, cells[index + span].isContinuation { span += 1 }
        runs.append((String(cell.text ?? " "), cell.style, span))
        index += span
        continue
      }
      if columns == 0 {
        style = cell.style
      } else if cell.style != style {
        runs.append((text, style, columns))
        text = ""
        columns = 0
        style = cell.style
      }
      text.append(cell.text ?? " ")
      columns += 1
      index += 1
    }
    if columns > 0 { runs.append((text, style, columns)) }
    return runs
  }

  /// Plain text, trailing blanks trimmed. Used for copy and for tests.
  public var plainText: String {
    var text = ""
    for cell in cells where !cell.isContinuation {
      text.append(cell.text ?? " ")
    }
    while text.last == " " { text.removeLast() }
    return text
  }

  /// One past the last cell worth drawing: a trailing blank stays only while
  /// its style paints something on its own.
  private var drawnEnd: Int {
    var end = cells.count
    while end > 0 {
      let cell = cells[end - 1]
      if cell.isBlank, !cell.style.paintsBlank { end -= 1 } else { break }
    }
    return end
  }
}

/// What the program asked the terminal to track with the mouse. Recorded, not
/// implemented: the view decides whether a phone gesture becomes a report.
public enum VTMouseTracking: Equatable, Sendable {
  case none
  /// Mode 1000: presses and releases.
  case click
  /// Mode 1002: plus motion while a button is held.
  case drag
  /// Mode 1003: all motion.
  case any
}

public enum VTKey: Equatable, Sendable {
  case char(Character)
  case enter, tab, backspace, escape
  case up, down, left, right, home, end, pageUp, pageDown, delete
  case function(Int)
  /// ctrl-c etc: the caller passes `c`.
  case control(Character)
}

/// How many cells one scalar takes: 0 for a mark that rides on the cell before
/// it, 2 for East Asian Wide/Fullwidth and emoji-presentation scalars, 1 for
/// everything else. Per scalar rather than per grapheme on purpose: the program
/// on the other end laid its output out with a per-codepoint `wcwidth`, and
/// xterm.js (the other client on this stream) measures the same way, so a ZWJ
/// family lands as three wide cells here exactly as it does there. The one
/// departure is the skin-tone modifiers, which ride on their base so the glyph
/// draws as one emoji rather than an emoji and a swatch.
enum VTWidth {
  /// East Asian Wide/Fullwidth blocks that no scalar property exposes; the
  /// emoji half of the W table is `isEmojiPresentation`.
  private static let wide: [ClosedRange<UInt32>] = [
    0x1100...0x115F, 0x2329...0x232A, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF,
    0x4E00...0x9FFF, 0xA000...0xA4CF, 0xA960...0xA97F, 0xAC00...0xD7A3, 0xF900...0xFAFF,
    0xFE10...0xFE19, 0xFE30...0xFE6F, 0xFF00...0xFF60, 0xFFE0...0xFFE6, 0x16FE0...0x16FE4,
    0x17000...0x18AFF, 0x1B000...0x1B2FF, 0x1F200...0x1F251, 0x20000...0x2FFFD, 0x30000...0x3FFFD,
  ]

  static func of(_ scalar: Unicode.Scalar) -> Int {
    let value = scalar.value
    if value < 0x300 { return 1 }
    if value >= 0x1160 && value <= 0x11FF { return 0 }
    switch scalar.properties.generalCategory {
    case .nonspacingMark, .enclosingMark, .format: return 0
    default: break
    }
    if value >= 0x1F3FB && value <= 0x1F3FF { return 0 }
    if value < 0x1100 { return 1 }
    if scalar.properties.isEmojiPresentation {
      return value >= 0x1F1E6 && value <= 0x1F1FF ? 1 : 2
    }
    for range in wide where range.contains(value) {
      return 2
    }
    return 1
  }
}
