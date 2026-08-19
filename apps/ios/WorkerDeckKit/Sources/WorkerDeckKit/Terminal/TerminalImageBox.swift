import Foundation

/// The box a tool result's image is drawn in, and the words drawn in it before
/// the bytes arrive — the port of `packages/ui/src/components/terminal/image-box.ts`.
///
/// Its own module, and pure, for `ResultPreview`'s reason with a constant
/// standing where a string stood: the planner reserves these lines and the cell
/// draws into them, and two spellings of the box would be two different heights.
///
/// **A fixed box, sized in whole lines, reserved from plan time.** An image's
/// intrinsic dimensions are not knowable before its bytes are, and here that is
/// not a matter of prediction quality but of the model: the planner wraps and
/// the renderer draws the lines it returned, so a row whose height depended on
/// pixels nobody has fetched yet could not be planned at all. A box that does
/// not depend on what is inside it is exact by definition, at the cost of some
/// letterboxing — which is why `TerminalAudit` needs no new claim for it.
public enum TermImage {
  /// Whole lines per image. 12, the same constant the web client uses — ≈ 240px
  /// at an 18pt line: big enough that a screenshot is legible as *what it is*
  /// (the whole reason images became visible at all), small enough that a call
  /// returning four of them is not a screenful.
  public static let boxLines = 12

  /// What the box says before the fetch lands.
  ///
  /// `bytes` is the decoded size the gateway stamped on the reference — this
  /// client holds no bytes at all until it asks for them, the same reason
  /// `total_chars` rides beside a truncated head. `TermFmt.bytes` rather than a
  /// spelling of its own: the theme says "336.0 KB" everywhere else.
  public static func placeholder(bytes: Int) -> String {
    "image · \(TermFmt.bytes(bytes))"
  }

  /// What it says when the fetch failed — a stale address after a dormant wake
  /// (the route 404s rather than serving another call's pixels), a gateway too
  /// old to know the route, a dropped tailnet.
  ///
  /// It occupies the same box, because the alternative is a row changing height
  /// on a network failure. Staying silent is not an option the way it is for a
  /// produced file: that card names a host path in its result text, so a reader
  /// can still find the picture; a replayed image part has no path to name.
  public static let unavailable = "image unavailable"
}
