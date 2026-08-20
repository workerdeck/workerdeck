import SwiftUI
import UIKit
import WorkerDeckKit

/// The prompt of the turn you are reading, held at the top of the scroller —
/// the CLI's own affordance, and the web client's `stickyPrompt`.
///
/// **One line, and the prompt's first line.** Not the row: a pasted twenty-line
/// prompt pinned whole covers the very answer being read, which is the thing a
/// reader scrolled here for. The planner already puts the marker on the first
/// line only (a pasted prompt is one prompt, not twenty), so the first planned
/// line is exactly the right thing to lift.
///
/// **Where it parts company with the web client, and why it is easy here.**
/// There the pin is the browser's: a lane per turn, an absolutely positioned
/// head, a sentinel `IntersectionObserver` to know when it stuck, and the
/// compositor doing pin and push-off, because a JS-written pin trails the
/// compositor and wobbles. None of that machinery is available or needed on
/// this renderer — the height book knows the pixel offset of every row,
/// mounted or not, so "which prompt am I under" is a binary search and "how far
/// has the next one pushed this one off" is a subtraction. This is the height
/// book's fourth payoff, after the scrubber, the exact `estimateSize` and the
/// selection arithmetic.
///
/// Two rules, one of them a deliberate revision of the web client's:
///
/// - **It must not perform the row's press.** A tap on the pinned copy that
///   expanded a block would be acting on something the reader cannot see. What
///   it does instead is the one thing a header naming a place can do honestly:
///   **jump to that prompt.** The pin already knows the row, and `scrollToRow`
///   already goes through the row model, so it is a navigation rather than an
///   action on hidden content.
/// - **It must not be a header.** The line is drawn by the same primitives at
///   the same geometry, so it lands on the column its own row sits on. A
///   separate header with its own text arrangement drifts by a fraction of a
///   cell, which reads as the font being wrong. So the line stays on the grid,
///   at the grid's own *y*, and the only chrome is a rule under it — the strip
///   has to hand over to the next one without moving the line a pixel, and air
///   above it is exactly what would move it.
struct TerminalStickyPromptView: View {
  let rows: TerminalRows
  let book: TerminalHeightBook
  let metrics: TerminalMetrics
  let typography: TerminalTypography
  let expansion: TerminalExpansion
  let bleed: CGFloat
  /// Read here and nowhere above, so a scroll re-renders this strip alone. The
  /// same decomposition the scrubber's band needs, and for the same reason:
  /// observation is per body, and reading the offset beside the row list would
  /// rebuild the row list on every frame of a fling.
  let scroll: TranscriptScrollModel
  /// Ascending row indices of the human's prompts, from `rows.promptRows`.
  /// Passed in rather than derived, because deriving it is a walk of the
  /// transcript and it only changes when the fold does.
  let promptRows: [Int]
  /// Take me to that prompt. The one thing a header naming a place can do
  /// honestly — and it goes through the row model, like every other jump.
  let onJumpToRow: (Int) -> Void

  /// The rule under the line, and the only thing the strip carries beyond the
  /// line itself.
  ///
  /// **There is deliberately no air above the line.** There was — 5pt of it —
  /// and it put the pinned copy 5pt below where the real line sits at the
  /// moment of hand-off, so every takeover jumped the line down by exactly that
  /// padding. The lift out is continuous, which is why only the arrival
  /// glitched. A header that is the same line at the same geometry has to
  /// arrive at the same *y* too, so the line is on the grid and the rule is the
  /// only chrome.
  private static let rule: CGFloat = 1

  /// Line plus rule, and it must equal the `VStack`'s own height or `.clipped()`
  /// eats the difference — which is what used to happen to the rule: the strip
  /// measured `line + 10` while the stack drew `line + 11`, so the hairline was
  /// cut off every frame and had never once been seen.
  private var stripHeight: CGFloat { metrics.line + Self.rule }

  var body: some View {
    if let pinned {
      VStack(spacing: 0) {
        TerminalLineStrip(
          line: pinned.line, typography: typography, metrics: metrics, bleed: bleed)
          .frame(height: metrics.line)
        // A rule, not a shadow or a box: the strip has to end somewhere, and a
        // hairline is how this theme says so everywhere else. With the air gone
        // it is the whole of what separates the held line from the moving text
        // under it, so it has to actually be drawn — see `stripHeight`.
        Rectangle()
          .fill(TerminalPalette.nestedRule)
          .frame(height: Self.rule)
      }
      .background(Color(uiColor: .systemBackground))
      // Push-off: the next prompt does not slide under this one, it lifts it
      // out. Drawn by moving the strip, and clipped by the container, so the
      // outgoing strip is cut off at the top edge exactly as a sticky header
      // would be.
      .offset(y: pinned.offset)
      .frame(height: stripHeight, alignment: .top)
      .clipped()
      .contentShape(Rectangle())
      .onTapGesture { onJumpToRow(pinned.row) }
      .accessibilityAddTraits(.isButton)
      .accessibilityLabel("Go to this prompt")
    }
  }

  /// The arithmetic is `StickyPrompt.resolve`, in the kit, where a test can
  /// drive it — this view only draws what it returns. The strip's own height
  /// goes in, not the grid line: the hand-off has to be measured against what
  /// is on screen, the rule included.
  private var pinned: (line: TermLine, offset: CGFloat, row: Int)? {
    guard
      let pin = StickyPrompt.resolve(
        promptRows: promptRows, rows: rows, book: book, top: scroll.contentOffset,
        line: metrics.line, stripHeight: stripHeight),
      let line = TerminalPlanner.plan(rows[pin.row], metrics: metrics, expansion: expansion).first
    else { return nil }
    return (line, pin.offset, pin.row)
  }
}

/// One planned line, drawn by the row cell's own primitives.
///
/// A `UIViewRepresentable` around the same backdrop/gutter/body triple a row
/// cell uses, because the whole claim of the sticky prompt is that it is *the
/// same line* — a second renderer would be a second set of column arithmetic,
/// and the drift would be a fraction of a cell.
struct TerminalLineStrip: UIViewRepresentable {
  let line: TermLine
  let typography: TerminalTypography
  let metrics: TerminalMetrics
  let bleed: CGFloat

  func makeUIView(context: Context) -> TerminalRowCell { TerminalRowCell(frame: .zero) }

  func updateUIView(_ view: TerminalRowCell, context: Context) {
    view.configure(
      lines: [line], typography: typography, metrics: metrics, gapAbove: false, bleed: bleed,
      onPress: { _ in })
    // A copy is not the text. Selecting the pinned line would put the reader's
    // selection somewhere they cannot see it, and it would swallow the tap that
    // takes them to the real row.
    view.bodyIsSelectable = false
    // The band is the row's own wash and it is what makes the strip opaque
    // enough to sit over moving text. Nothing else may show through.
    view.backgroundColor = UIColor.systemBackground
  }
}
