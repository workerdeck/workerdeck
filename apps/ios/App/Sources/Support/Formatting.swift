import Foundation

// The list rows' last few labels, until those rows read core records; every session-screen string comes from the core.
enum Fmt {
  static func ago(epochMs: Double, now: Date = Date()) -> String {
    elapsed(seconds: now.timeIntervalSince1970 - epochMs / 1000)
  }

  private static func elapsed(seconds: Double) -> String {
    guard seconds > 0 else { return "just now" }
    if seconds < 60 { return "just now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
    return "\(Int(seconds / 86_400))d"
  }

  static func bytes(_ count: Int) -> String {
    let value = Double(count)
    if value < 1000 { return "\(count) B" }
    if value < 1_000_000 { return String(format: "%.1f kB", value / 1000) }
    return String(format: "%.1f MB", value / 1_000_000)
  }

  // Not through `URL`, which percent-encodes characters it dislikes.
  static func lastComponent(_ path: String) -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: true)
    return parts.last.map(String.init) ?? path
  }
}
