import Foundation

/// Small, allocation-free-ish formatters. Deliberately hand-rolled rather than
/// `RelativeDateTimeFormatter`/`ByteCountFormatter`: the outputs here are compact
/// chip labels ("3m", "1.2 kB", "$0.0142"), not prose, and the Foundation
/// formatters are neither `Sendable` nor cheap to build per row.
enum Fmt {
  /// "just now" / "5m" / "3h" / "2d", from an epoch-milliseconds timestamp.
  static func ago(epochMs: Double, now: Date = Date()) -> String {
    elapsed(seconds: now.timeIntervalSince1970 - epochMs / 1000)
  }

  /// "in 42m" / "in 3h 10m" — for a rate-limit window reset (epoch **seconds**).
  static func until(epochSeconds: Double, now: Date = Date()) -> String? {
    let remaining = epochSeconds - now.timeIntervalSince1970
    guard remaining > 0 else { return nil }
    if remaining < 3600 { return "in \(Int(remaining / 60))m" }
    let hours = Int(remaining / 3600)
    let minutes = Int((remaining - Double(hours) * 3600) / 60)
    if hours < 24 { return minutes == 0 ? "in \(hours)h" : "in \(hours)h \(minutes)m" }
    return "in \(hours / 24)d \(hours % 24)h"
  }

  private static func elapsed(seconds: Double) -> String {
    guard seconds > 0 else { return "just now" }
    if seconds < 60 { return "just now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
    return "\(Int(seconds / 86_400))d"
  }

  /// A *turn's* cost, at the precision the protocol reports it: "$0.0142".
  ///
  /// Deliberately not the web's `formatCost`, which rounds to cents and floors
  /// at `<$0.01` — most single turns cost less than a cent, and a column of
  /// `<$0.01` says nothing. For a **session total**, where the three clients sit
  /// side by side and are compared, use `TermFmt.cost`, which *is* that port.
  static func cost(_ usd: Double) -> String {
    usd >= 10 ? String(format: "$%.2f", usd) : String(format: "$%.4f", usd)
  }

  /// Turn duration: "820ms" / "3.2s" / "1m 04s".
  static func duration(ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    let seconds = ms / 1000
    if seconds < 60 { return String(format: "%.1fs", seconds) }
    return String(format: "%dm %02ds", Int(seconds) / 60, Int(seconds) % 60)
  }

  static func bytes(_ count: Int) -> String {
    let value = Double(count)
    if value < 1000 { return "\(count) B" }
    if value < 1_000_000 { return String(format: "%.1f kB", value / 1000) }
    return String(format: "%.1f MB", value / 1_000_000)
  }

  /// "12.3k" for token counts, which are always large and never need units.
  static func tokens(_ count: Int) -> String {
    if count < 1000 { return "\(count)" }
    if count < 1_000_000 { return String(format: "%.1fk", Double(count) / 1000) }
    return String(format: "%.2fM", Double(count) / 1_000_000)
  }

  static func percent(_ value: Double) -> String {
    "\(Int(value.rounded()))%"
  }

  /// Last path component of a POSIX path, without going through `URL` (which
  /// mangles paths containing characters it wants to percent-encode).
  static func lastComponent(_ path: String) -> String {
    let parts = path.split(separator: "/", omittingEmptySubsequences: true)
    return parts.last.map(String.init) ?? path
  }

  /// Collapse whitespace and clip, for one-line summaries in collapsed cards.
  static func oneLine(_ text: String, limit: Int = 140) -> String {
    let flattened = text.split(whereSeparator: \.isNewline).joined(separator: " ")
      .trimmingCharacters(in: .whitespaces)
    guard flattened.count > limit else { return flattened }
    return String(flattened.prefix(limit)) + "…"
  }

  /// Human label for a rate-limit window key ('five_hour' → "5h",
  /// 'seven_day_opus' → "7d opus"). The per-model suffix is open — the CLI adds
  /// buckets as plans gain them — so it is rewritten rather than enumerated.
  static func rateLimitWindow(_ key: String) -> String {
    switch key {
    case "five_hour": return "5h"
    case "seven_day": return "7d"
    default:
      let spaced = key.replacingOccurrences(of: "_", with: " ")
      guard key.hasPrefix("seven_day_") else { return spaced }
      return "7d " + spaced.dropFirst("seven day ".count)
    }
  }

  /// The same key spelled out, for the usage sheet where there is room:
  /// 'five_hour' → "5-hour session", 'seven_day_fable' → "Weekly · Fable".
  static func rateLimitWindowLong(_ key: String) -> String {
    switch key {
    case "five_hour": return "5-hour session"
    case "seven_day": return "Weekly"
    case "seven_day_oauth_apps": return "Weekly · apps"
    default:
      guard key.hasPrefix("seven_day_") else {
        return key.replacingOccurrences(of: "_", with: " ").capitalized
      }
      let model = key.dropFirst("seven_day_".count).replacingOccurrences(of: "_", with: " ")
      return "Weekly · " + model.capitalized
    }
  }

  /// How long a rate-limit window is, in seconds — the denominator behind the
  /// pace marker. Derived from the key rather than reported: the CLI sends a
  /// reset time and a percentage, never a duration. Unknown for a window whose
  /// key doesn't say (the marker is then simply not drawn).
  static func rateLimitWindowSeconds(_ key: String) -> Double? {
    if key == "five_hour" { return 5 * 3600 }
    if key.hasPrefix("seven_day") { return 7 * 86_400 }
    return nil
  }

  /// Long-form reset line for the usage sheet: "Resets in 2h 57m".
  static func resets(epochSeconds: Double, now: Date = Date()) -> String? {
    guard let until = until(epochSeconds: epochSeconds, now: now) else { return nil }
    return "Resets " + until
  }

  /// "8 secs ago" / "3 mins ago" — the usage sheet's freshness line, which is
  /// finer-grained than `ago` (a poll that just landed should say so).
  static func agoPrecise(_ date: Date, now: Date = Date()) -> String {
    let seconds = max(0, now.timeIntervalSince(date))
    if seconds < 60 { return "\(Int(seconds)) sec\(Int(seconds) == 1 ? "" : "s") ago" }
    if seconds < 3600 {
      let minutes = Int(seconds / 60)
      return "\(minutes) min\(minutes == 1 ? "" : "s") ago"
    }
    let hours = Int(seconds / 3600)
    return "\(hours) hour\(hours == 1 ? "" : "s") ago"
  }
}
