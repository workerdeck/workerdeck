import Foundation

/// Which prompt is held at the top of the scroller, and how far the next one has
/// pushed it off — the arithmetic behind the web client's `stickyPrompt`.
///
/// **One line, and the prompt's first line.** Not the row: a pasted twenty-line
/// prompt pinned whole covers the very answer being read. The planner already
/// puts the marker on the first line only (a pasted prompt is one prompt, not
/// twenty), so the first planned line is exactly the right thing to lift.
///
/// **Why this is arithmetic here and machinery on the web.** There the pin is
/// the browser's — a lane per turn, an absolutely positioned head, a sentinel
/// `IntersectionObserver` to know when it stuck, and the compositor doing pin
/// and push-off, because a JS-written pin trails the compositor and wobbles.
/// This renderer knows the pixel offset of every row, mounted or not, so "which
/// prompt am I under" is a binary search and "how far has the next one pushed
/// this one" is a subtraction. The height book's fourth payoff, after the
/// scrubber, the exact row heights and the selection hit test.
///
/// It lives in the kit rather than in the view for the reason everything else
/// here does: a view cannot be driven by a test, and this is the part that can
/// be wrong.
public enum StickyPrompt {
  /// What to draw at the top edge, or `nil` for nothing.
  public struct Pin: Equatable, Sendable {
    /// The row the pinned line came from — the caller plans it.
    public var row: Int
    /// How far to lift the line, `0` while it is fully pinned and negative
    /// while the next prompt is pushing it out. Never below `-line`.
    public var offset: CGFloat

    public init(row: Int, offset: CGFloat) {
      self.row = row
      self.offset = offset
    }
  }

  /// - Parameters:
  ///   - promptRows: ascending row indices of the human's own prompts
  ///     (`TerminalRows.promptRows`).
  ///   - top: the viewport's top edge, in content space.
  ///   - line: the grid line, which is what a row's blank-line gap is worth.
  ///   - stripHeight: how tall the drawn strip is, which is **not** the same
  ///     number. The strip is chrome rather than a row — it carries air above
  ///     and below its line and a rule under it — and the hand-off has to be
  ///     measured against what is actually on screen, or the next prompt slides
  ///     under the padding for a few points before the lift begins. Defaults to
  ///     `line`, which is the strip drawn as a bare row.
  public static func resolve(
    promptRows: [Int], rows: TerminalRows, book: TerminalHeightBook, top: CGFloat, line: CGFloat,
    stripHeight: CGFloat? = nil
  ) -> Pin? {
    let strip = stripHeight ?? line
    // **Content offsets throughout, never frame offsets.** The blank line above
    // a row belongs to the row (see `TerminalHeightBook`), so a prompt's frame
    // begins one line before its text does, and the strip in between is
    // visually the *previous* turn's. Searching by frame hands over a line
    // early — which showed up as the new prompt's row being "found" while its
    // own blank line was still at the top edge, and the pin vanishing for a
    // line rather than being lifted out.
    let contentTop = { (row: Int) in
      book.offset(at: row) + (rows.gapBefore(row) ? line : 0)
    }
    guard let index = lastPrompt(promptRows, atOrAbove: top, contentTop: contentTop)
    else { return nil }
    // Nothing to hold while the line is on screen in its own right: the pinned
    // copy would sit exactly over it, and two identical lines a pixel apart is
    // the seam this theme exists not to have. Strictly-above, so the pin takes
    // over on the frame the real line leaves.
    guard contentTop(index) < top else { return nil }

    guard let next = promptRows.first(where: { $0 > index }) else { return Pin(row: index, offset: 0) }
    let distance = contentTop(next) - top
    guard distance < strip else { return Pin(row: index, offset: 0) }
    return Pin(row: index, offset: max(-strip, distance - strip))
  }

  /// Binary search — a scroll event must not walk the transcript.
  static func lastPrompt(
    _ promptRows: [Int], atOrAbove offset: CGFloat, contentTop: (Int) -> CGFloat
  ) -> Int? {
    var low = 0
    var high = promptRows.count - 1
    var found: Int?
    while low <= high {
      let mid = (low + high) / 2
      if contentTop(promptRows[mid]) <= offset {
        found = promptRows[mid]
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }
}
