import Foundation

// Ports of `packages/ui/src/lib/format.ts`, deliberately not the app's `Fmt`: the terminal theme spells these as the web does.
public enum TermFmt {
  /// `formatCost` - `nil`/NaN reads "-" rather than "$0.00", because "we do not
  /// know" and "it was free" are different facts.
  public static func cost(_ usd: Double?) -> String {
    guard let usd, !usd.isNaN else { return "-" }
    if usd == 0 { return "$0.00" }
    if usd < 0.01 { return "<$0.01" }
    return String(format: "$%.2f", usd)
  }

  /// `formatDuration` - "820ms" / "3.2s" / "1m 4s".
  public static func duration(ms: Double) -> String {
    if ms < 1000 { return "\(Int(ms.rounded()))ms" }
    let seconds = ms / 1000
    if seconds < 60 { return String(format: "%.1fs", seconds) }
    let minutes = Int(seconds / 60)
    return "\(minutes)m \(Int((seconds.truncatingRemainder(dividingBy: 60)).rounded()))s"
  }

  /// `formatBytes` - binary thresholds, decimal-ish labels, exactly as the web
  /// client spells them.
  public static func bytes(_ count: Int) -> String {
    let value = Double(count)
    if value >= 1024 * 1024 { return String(format: "%.1f MB", value / (1024 * 1024)) }
    if value >= 1024 { return String(format: "%.1f KB", value / 1024) }
    return "\(count) B"
  }
}
