import Foundation

/// Which APNs environment this build's device token belongs to.
///
/// The trap this exists to close: a build run from Xcode gets a **sandbox**
/// token, a TestFlight or App Store build gets a **production** one, and the two
/// namespaces do not overlap. Same key, same device, different token — push a
/// sandbox token at `api.push.apple.com` and Apple answers `BadDeviceToken`, and
/// the other way round too. So the app *tells* the gateway which environment it
/// registered in rather than leaving the operator to guess.
enum PushEnvironment: String, Sendable {
  case development
  case production

  /// Resolved once: it cannot change without the app being reinstalled.
  static let current: PushEnvironment = detect()

  private static func detect() -> PushEnvironment {
    if let value = provisioningEntitlement("aps-environment") {
      return PushEnvironment(rawValue: value) ?? .production
    }
    // No embedded profile: the Simulator, where there is no real token anyway
    // and `simctl push` bypasses APNs entirely.
    #if DEBUG
      return .development
    #else
      return .production
    #endif
  }

  /// `embedded.mobileprovision` is a CMS envelope wrapped around a plist. Rather
  /// than decode PKCS#7, slice the plist out by its delimiters — crude, but it
  /// is the standard trick, needs no dependency, and the alternative (guessing
  /// from `#if DEBUG`) is wrong for a Release build run from Xcode.
  private static func provisioningEntitlement(_ key: String) -> String? {
    guard
      let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let data = try? Data(contentsOf: url),
      let start = data.range(of: Data("<plist".utf8)),
      let end = data.range(
        of: Data("</plist>".utf8), options: [], in: start.upperBound..<data.endIndex)
    else { return nil }
    let plist = data[start.lowerBound..<end.upperBound]
    guard
      let profile = try? PropertyListSerialization.propertyList(from: plist, format: nil)
        as? [String: Any],
      let entitlements = profile["Entitlements"] as? [String: Any]
    else { return nil }
    return entitlements[key] as? String
  }
}
