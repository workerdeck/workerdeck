import SwiftUI
import UIKit
import WorkerDeckKit

/// The terminal grid's numbers, measured — the iOS counterpart of the web
/// theme's `--term-font-size: 13px; --term-line: 18px` pair and of the VS Code
/// host's cell resolution ("rounded, because a fractional cell puts every
/// other row on a half-pixel").
///
/// Everything here exists to make one guarantee true: **N pre-wrapped lines
/// render at exactly N × `line` points.** The calculator wraps
/// (`TerminalCells.wrapped`), the renderer draws those exact lines, and this
/// type is where the two agree on the pixels.
///
/// The two ways a row view can draw its lines and keep the guarantee:
///
/// 1. **One `Text` per wrapped line**, each in a fixed box:
///    `Text(line).font(t.font).frame(height: t.line)`, stacked with spacing 0.
///    N boxes of `line` points are N × `line` by construction — no font
///    arithmetic can break it, which is why the placeholder rows use it and
///    why it is the recommended shape for gutter-bearing rows (the gutter cell
///    is a box on the same grid anyway).
///
/// 2. **One multi-line `Text`** (markdown paragraphs want this):
///    `.font(t.font).lineSpacing(t.lineSpacing).padding(.vertical, t.linePadding)`.
///    The arithmetic: a SwiftUI `Text`'s line box is the font's own
///    `lineHeight` (ascent + descent + leading), and `.lineSpacing` inserts
///    its value **between** fragments only — N lines measure
///    N·lineHeight + (N−1)·spacing, one `spacing` short of N·`line`. The
///    vertical padding of `spacing / 2` per edge makes up the difference *and*
///    optically centers each line in its `line`-point slot, so recipe 2 sits
///    on the same baselines as recipe 1.
///
/// The font's own `lineHeight` is fractional (SF Mono at 13pt is ~15.5) and
/// deliberately left so: the whole-point rule governs **row boundaries** — a
/// row's height and offset, where a half-pixel seam would soften every second
/// row's background and gutter rule — while a baseline inside a row is the
/// text system's own business and always has been.
struct TerminalTypography: Equatable {
  /// The face everything measures against and draws with. Bridged to SwiftUI
  /// via `font` rather than respelled `.system(size:design:)` so the renderer
  /// cannot resolve to a different face than the one that was measured.
  let uiFont: UIFont
  /// Whole points — the input, rounded, so the pair (fontSize, cell, line) is
  /// reproducible and cacheable.
  let fontSize: CGFloat
  /// The advance of one character cell, whole points. See `measure` for why
  /// this is a ceiling, not a rounding.
  let cell: CGFloat
  /// One line of the grid, whole points.
  let line: CGFloat

  var font: Font { Font(uiFont) }

  /// What `.lineSpacing(_:)` needs for recipe 2 — the slack between the grid
  /// line and the font's natural line box.
  var lineSpacing: CGFloat { line - uiFont.lineHeight }
  /// Recipe 2's `.padding(.vertical, _)` — half the slack per edge.
  var linePadding: CGFloat { (line - uiFont.lineHeight) / 2 }

  /// Build the kit's metrics for a given content width. `width` is floored:
  /// the column budget divides by the cell, and a fractional width could round
  /// a column into existence that the frame cannot actually hold.
  func metrics(width: CGFloat) -> TerminalMetrics {
    TerminalMetrics(cell: cell, line: line, width: floor(width), fontSize: fontSize)
  }

  /// Measure the grid for a font size.
  ///
  /// The cell is **measured, never derived from the size**: a monospace
  /// advance is a property of the face (SF Mono's is 0.6 em; another face's is
  /// not), and 13pt is 7.8pt of advance, not any number you could guess from
  /// 13. Two hundred zeros divided by two hundred rather than one glyph, so a
  /// sub-pixel edge in one measurement averages away.
  ///
  /// The cell is then taken to the next whole point **upward**. Whole, because
  /// every horizontal measure on this surface (gutter, indents, column budget)
  /// is a multiple of it — but the *cell* is kept at its exact measured advance,
  /// not rounded to a point.
  ///
  /// Rounding it *down* would be unsafe: a 7.2pt advance read as 7 lets the
  /// planner approve a line a character wider than the row, and the text system
  /// answers with a truncation ellipsis in a transcript that never elides.
  /// Rounding it *up* is safe but not free, and the cost is easy to
  /// underestimate — it is not a fraction of a character per line, it is a
  /// fraction per *cell*, accumulated across the whole line. At 12pt the advance
  /// is ~7.2 and the ceiling is 8, so a 360pt body fits 45 columns instead of
  /// 49: four characters a line, about nine percent of the transcript, given up
  /// for a rounding nobody asked for.
  ///
  /// Not rounding at all has neither problem. `cols = floor(body / cell)` is
  /// exact when `cell` is the true advance, so `cols · advance ≤ body` holds by
  /// construction rather than by margin. Only the **line** must be a whole
  /// point, and for a different reason: a fractional line puts every second row
  /// on a half-pixel, which softens the text and seams the diff bands.
  ///
  /// The line is the web pair's ratio (18/13 ≈ 1.38) applied to the size,
  /// floored by the font's own line height — the grid must never be shorter
  /// than the glyphs it holds.
  /// The size every terminal surface in a session draws at, and the reason it
  /// is a constant here rather than a number in each view.
  ///
  /// The session screen mounts more than one terminal surface — the transcript,
  /// and now the approval and question prompts under it — and the web client
  /// learned this the expensive way: `SessionPanel.terminalMetrics` is **one**
  /// prop precisely because handing two surfaces different numbers puts the
  /// prompt's gutter glyph on a different column from every marker above it,
  /// which is the single failure this theme exists to prevent.
  static let sessionFontSize: CGFloat = 12

  /// The measured grid for that size. Cheap enough to recompute (one `size(
  /// withAttributes:)` on a 200-character sample) and already evaluated per
  /// body pass by the transcript.
  static var session: TerminalTypography { measure(fontSize: sessionFontSize) }

  static func measure(fontSize raw: CGFloat) -> TerminalTypography {
    let size = max(8, raw.rounded())
    let uiFont = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    let sample = String(repeating: "0", count: 200) as NSString
    let advance = sample.size(withAttributes: [.font: uiFont]).width / 200
    // Shave float noise only — an advance of 8.0000001 is 8, and nothing else
    // is rounded.
    let cell = (advance * 1000).rounded() / 1000
    let line = max(ceil(uiFont.lineHeight), (size * 18 / 13).rounded())
    return TerminalTypography(uiFont: uiFont, fontSize: size, cell: cell, line: line)
  }
}
