import SwiftUI
import WorkerDeckKit

/// The engine's own mark, in the vendor's own colour — the phone's counterpart
/// to `EngineIcon` in `packages/ui`.
///
/// The web draws these inline from a table of single-path SVGs. SwiftUI has no
/// path-data parser, so the phone reads real vector assets out of the catalog,
/// generated from that very table by `apps/ios/scripts/gen-engine-marks.mjs`.
/// They are template images, so the tint below is what colours them.
///
/// **Absent draws nothing at all** — not a placeholder dot, which is what the
/// web falls back to. A dot earns its keep in a mouse-width sidebar where the
/// two text columns have to line up under a shared gutter; a phone row is one
/// leading-aligned run and an anonymous dot in front of it is a smudge.
///
/// The marks are trademarks of their owners (Anthropic, OpenAI, Google,
/// DeepSeek, Moonshot), used only to identify which engine a session runs on.
struct EngineIconView: View {
  let engine: String
  let model: String?
  var size: CGFloat = 11

  var body: some View {
    if let mark = engineMark(engine: engine, model: model) {
      Image(mark.assetName)
        .renderingMode(.template)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: size, height: size)
        .foregroundStyle(mark.tintsMark ? VendorPalette.color(mark) : Color.secondary)
        .accessibilityHidden(true)
    }
  }
}

/// The vendor colours, ported value-for-value from `--vendor-*` in
/// `packages/ui/src/styles/theme.css`.
///
/// Two values each because a 12px glyph has to hold against both grounds: the
/// dark-ground value is lifted and the light-ground one darkened. OpenAI's is
/// monochrome by *their* rule rather than our taste — their guidelines forbid
/// adding colour to the mark — and the light value is a near-black rather than
/// `#000`, so the mark does not sit harder than the title it labels.
///
/// A `UIColor(dynamicProvider:)` for the same reason `TerminalPalette` is one:
/// these are hex pairs, not semantic roles, so the trait swap has to be spelled
/// out rather than inherited from a system colour.
enum VendorPalette {
  static func color(_ mark: EngineMark) -> Color {
    switch mark {
    case .claude: return dynamic(dark: 0xCC_7C_5E, light: 0xB3_57_3A)
    case .codex: return dynamic(dark: 0xFF_FF_FF, light: 0x37_37_37)
    // No token of their own yet — adding one is a case here and two
    // declarations in `theme.css`, in that order.
    case .gemini, .deepseek, .moonshot: return .secondary
    }
  }

  private static func dynamic(dark: UInt32, light: UInt32) -> Color {
    Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
  }
}

private extension UIColor {
  convenience init(hex: UInt32) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: 1)
  }
}
