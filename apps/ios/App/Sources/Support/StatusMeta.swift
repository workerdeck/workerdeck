import WorkerDeckKit
import SwiftUI

/// Presentation for `SessionStatus`, mirroring the web dashboard's `STATUS_META`
/// so the two clients read the same at a glance. Semantic colors only, so dark
/// mode and increased contrast come for free.
extension SessionStatus {
  var label: String {
    switch self {
    case .starting: return "Starting"
    case .running: return "Running"
    case .awaitingApproval: return "Needs approval"
    case .idle: return "Idle"
    case .parked: return "Parked"
    case .failed: return "Failed"
    case .closed: return "Closed"
    }
  }

  var tint: Color {
    switch self {
    case .starting, .running: return .blue
    case .awaitingApproval: return .orange
    case .idle: return .green
    case .parked: return .purple
    case .failed: return .red
    case .closed: return .secondary
    }
  }

  /// Whether a turn is in flight — drives the spinner and the stop button.
  var isBusy: Bool {
    switch self {
    case .starting, .running, .awaitingApproval: return true
    case .idle, .parked, .failed, .closed: return false
    }
  }
}

extension PermissionMode {
  /// The names Claude Code itself uses. Notably `default` is **"Manual"** — the
  /// wire value is `default`, but calling it that in the UI conflates a real mode
  /// (ask me every time) with "whatever the server picked", which is the one
  /// confusion the status bar exists to avoid.
  var label: String {
    switch self {
    case .default: return "Manual"
    case .acceptEdits: return "Accept edits"
    case .bypassPermissions: return "Bypass permissions"
    case .plan: return "Plan"
    case .dontAsk: return "Don't ask"
    case .auto: return "Auto"
    }
  }

  /// The chip form, for the status bar — where the label shares a line with three
  /// other things and "Bypass permissions" would eat half of it.
  var shortLabel: String {
    switch self {
    case .default: return "Manual"
    case .acceptEdits: return "Edits"
    case .bypassPermissions: return "Bypass"
    case .plan: return "Plan"
    case .dontAsk: return "Don't ask"
    case .auto: return "Auto"
    }
  }

  /// What the mode actually does, for the picker — the same one-liners the CLI's
  /// own mode selector shows.
  var summary: String {
    switch self {
    case .default: return "Always ask before making changes"
    case .acceptEdits: return "Automatically accept all file edits"
    case .bypassPermissions: return "Skip every approval — the agent is unsupervised"
    case .plan: return "Create a plan before making changes"
    // The CLI's own definition, and the opposite of bypass: it never prompts,
    // and anything not already permitted is denied rather than allowed.
    case .dontAsk: return "Never ask — deny anything not pre-approved"
    case .auto: return "Claude handles permission decisions"
    }
  }

  /// Picker icon. Matched to the CLI's selector where it has one, so the two
  /// surfaces are recognisably the same list.
  var symbol: String {
    switch self {
    case .default: return "hand.raised.fill"
    case .acceptEdits: return "chevron.left.forwardslash.chevron.right"
    case .bypassPermissions: return "exclamationmark.triangle.fill"
    case .plan: return "list.bullet.rectangle.portrait.fill"
    case .dontAsk: return "checkmark.shield.fill"
    case .auto: return "bolt.fill"
    }
  }

  /// Icon colour in the picker. Distinct from `tint`, which is the chip's
  /// severity ramp — here it is identity, so `default` gets a colour rather than
  /// the chip's deliberately-quiet grey.
  var symbolTint: Color {
    switch self {
    case .default: return .primary
    case .acceptEdits: return .indigo
    case .plan: return .blue
    case .auto: return .orange
    case .dontAsk: return .orange
    case .bypassPermissions: return .red
    }
  }

  /// How much of the approval gate this mode gives away — the chip is the only
  /// place a bypassing session announces itself mid-run.
  var tint: Color {
    switch self {
    case .default, .auto: return .secondary
    case .plan: return .blue
    case .acceptEdits, .dontAsk: return .orange
    case .bypassPermissions: return .red
    }
  }
}

extension Color {
  /// A color the CLI reported for a context-usage category.
  ///
  /// The protocol warns that `color` is *often* one of the CLI's own theme token
  /// names ('inactive', 'promptBorder', …) rather than a real color. The web
  /// dashboard passes it through only when `CSS.supports('color', …)` accepts it;
  /// this is the same rule with the vocabulary UIKit can actually resolve —
  /// `#rgb`/`#rrggbb`/`#rrggbbaa` and the handful of CSS basic color keywords the
  /// CLI themes use. Anything else is a token, and the caller falls back.
  init?(cliToken token: String) {
    let value = token.trimmingCharacters(in: .whitespaces).lowercased()
    if value.hasPrefix("#") {
      guard let rgba = Color.hexComponents(String(value.dropFirst())) else { return nil }
      self.init(.sRGB, red: rgba.0, green: rgba.1, blue: rgba.2, opacity: rgba.3)
      return
    }
    guard let named = Color.cssKeywords[value] else { return nil }
    self = named
  }

  private static let cssKeywords: [String: Color] = [
    "black": .black, "blue": .blue, "brown": .brown, "cyan": .cyan, "gray": .gray,
    "grey": .gray, "green": .green, "indigo": .indigo, "magenta": .purple, "mint": .mint,
    "orange": .orange, "pink": .pink, "purple": .purple, "red": .red, "teal": .teal,
    "white": .white, "yellow": .yellow,
  ]

  private static func hexComponents(_ hex: String) -> (Double, Double, Double, Double)? {
    guard hex.allSatisfy(\.isHexDigit) else { return nil }
    let digits: [String]
    switch hex.count {
    case 3, 4: digits = hex.map { "\($0)\($0)" }
    case 6, 8: digits = stride(from: 0, to: hex.count, by: 2).map {
      let start = hex.index(hex.startIndex, offsetBy: $0)
      return String(hex[start..<hex.index(start, offsetBy: 2)])
    }
    default: return nil
    }
    let values = digits.compactMap { UInt8($0, radix: 16) }.map { Double($0) / 255 }
    guard values.count == digits.count else { return nil }
    return (values[0], values[1], values[2], values.count == 4 ? values[3] : 1)
  }
}

/// A filled dot + label, used for both the session list rows and the live header.
struct StatusBadge: View {
  let status: SessionStatus
  var pendingCount: Int = 0
  var compact = false

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(status.tint)
        .frame(width: 7, height: 7)
      Text(text)
        .font(compact ? .caption2 : .caption)
        .fontWeight(.medium)
        .foregroundStyle(status == .awaitingApproval ? Color.orange : Color.secondary)
    }
    .padding(.horizontal, compact ? 0 : 6)
    .padding(.vertical, compact ? 0 : 2)
    .background(
      compact
        ? nil
        : Capsule().fill(status.tint.opacity(0.12))
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel(text)
  }

  private var text: String {
    if status == .awaitingApproval, pendingCount > 0 {
      return "\(status.label) (\(pendingCount))"
    }
    return status.label
  }
}
