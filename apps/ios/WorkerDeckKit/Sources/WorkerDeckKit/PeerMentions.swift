import Foundation

/// `#Name` in the composer names another session on the gateway. The phone writes
/// the token, the gateway resolves it, and the two must fold a title the same way
/// or a name picked from the list would not match itself.
///
/// The Swift mirror of `packages/protocol/src/peer-mentions.ts`; there is no
/// module the two sides can share, so the rules are pinned by tests on both.
public enum PeerMentions {
  public static let sigil: Character = "#"

  /// Distinct sessions the gateway expands per message.
  public static let max = 4

  public static let bodyMax = 64

  /// What the composer writes for a session. An untitled one falls back to the
  /// short id the list already draws.
  public static func slug(title: String?, id: String) -> String {
    let folded = (title ?? "").precomposedStringWithCompatibilityMapping
    var out = ""
    var pendingDash = false
    for scalar in folded.unicodeScalars {
      if CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar) {
        if pendingDash, !out.isEmpty { out.append("-") }
        pendingDash = false
        out.unicodeScalars.append(scalar)
        if out.count >= bodyMax { break }
      } else {
        pendingDash = true
      }
    }
    return out.isEmpty ? String(id.prefix(8)) : out
  }

  /// The comparison key. Both sides fold; neither compares raw, so `#astra` finds
  /// `Astra` and `#fix_login_bug` finds `Fix login bug`.
  public static func key(_ body: String) -> String {
    let lowered = body.precomposedStringWithCompatibilityMapping.lowercased()
    var out = ""
    var pendingDash = false
    for character in lowered {
      if character == "-" || character == "_" || character.isWhitespace {
        pendingDash = !out.isEmpty
      } else {
        if pendingDash { out.append("-") }
        pendingDash = false
        out.append(character)
      }
    }
    return out
  }

  /// Whether a body could name a session at all: a letter or digit first, then
  /// letters, digits, `-` and `_`. So `#1` is shaped like one and `#-x` is not.
  public static func isBody(_ body: String) -> Bool {
    guard !body.isEmpty, body.count <= bodyMax, let first = body.first else { return false }
    guard first.isLetter || first.isNumber else { return false }
    return body.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
  }
}
