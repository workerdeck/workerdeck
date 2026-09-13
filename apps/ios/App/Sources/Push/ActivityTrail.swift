import Foundation

/// A breadcrumb log for card decisions, in UserDefaults so it survives the process.
///
/// A push-to-start card is created, handled and possibly ended in a background launch that lasts a
/// second or two, with no debugger attached and no console reachable. Whether a card never arrived
/// or arrived and was ended by this app is invisible from the lock screen and unknowable from
/// `Activity.activities` after the fact — so each decision writes a line here instead.
enum ActivityTrail {
  private static let key = "bi.atomic.workerdeck.ios.activityTrail"
  private static let limit = 40

  /// A no-op outside DEBUG: only the debug Settings section can read the trail back, so a release
  /// build writing it would be paying for evidence nobody can collect.
  static func note(_ line: String) {
    #if !DEBUG
      return
    #else
    let stamp = Self.formatter.string(from: Date())
    var lines = UserDefaults.standard.stringArray(forKey: key) ?? []
    lines.append("\(stamp) \(line)")
    UserDefaults.standard.set(lines.suffix(limit).map { $0 }, forKey: key)
    #endif
  }

  static func read() -> String {
    let lines = UserDefaults.standard.stringArray(forKey: key) ?? []
    return lines.isEmpty ? "trail empty" : lines.reversed().joined(separator: "\n")
  }

  static func clear() {
    UserDefaults.standard.removeObject(forKey: key)
  }

  private static let formatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()
}
