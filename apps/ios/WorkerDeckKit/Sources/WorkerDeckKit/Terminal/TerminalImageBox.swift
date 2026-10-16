import Foundation

// The image box's size and words, the port of `packages/ui/src/components/terminal/image-box.ts`.
public enum TermImage {
  /// Whole lines per image. 12, the same constant the web client uses - ≈ 240px
  /// at an 18pt line: big enough that a screenshot is legible as *what it is*
  /// (the whole reason images became visible at all), small enough that a call
  /// returning four of them is not a screenful.
  public static let boxLines = 12

  /// What the box says before the fetch lands.
  ///
  /// `bytes` is the decoded size the gateway stamped on the reference - this
  /// client holds no bytes at all until it asks for them, the same reason
  /// `total_chars` rides beside a truncated head. `TermFmt.bytes` rather than a
  /// spelling of its own: the theme says "336.0 KB" everywhere else.
  public static func placeholder(bytes: Int) -> String {
    "image · \(TermFmt.bytes(bytes))"
  }

  /// What it says when the fetch failed - a stale address after a dormant wake
  /// (the route 404s rather than serving another call's pixels), a gateway too
  /// old to know the route, a dropped tailnet.
  ///
  /// It occupies the same box, because the alternative is a row changing height
  /// on a network failure. Staying silent is not an option the way it is for a
  /// produced file: that card names a host path in its result text, so a reader
  /// can still find the picture; a replayed image part has no path to name.
  public static let unavailable = "image unavailable"
}
