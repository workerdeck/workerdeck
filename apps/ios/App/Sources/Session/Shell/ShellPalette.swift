import UIKit
import WorkerDeckKit

/// The colours a PTY can ask for, resolved for this renderer.
///
/// **Not ``TerminalPalette``**, and the distinction is the point. That palette is
/// the *theme's* vocabulary, where green means "this changed the workspace" and
/// yellow means "waiting on you"; those meanings are WorkerDeck's, assigned to
/// rows WorkerDeck draws. A shell's colours are the *program's*, and `ls` asking
/// for blue is not making a claim about a session. So the sixteen ANSI slots are
/// xterm's defaults, which is exactly what the dashboard gets: the web pane
/// overrides only foreground, background and cursor and inherits the rest from
/// xterm, so matching xterm here is what makes one shell read the same on a
/// phone and in a browser.
enum ShellPalette {
  /// The web pane's `xtermTheme` values, the light and dark pair.
  static var foreground: UIColor { dynamic(dark: 0xd4_d4_d4, light: 0x1f_23_28) }
  static var cursor: UIColor { foreground }

  /// xterm's default 16. The bright half is not "the same hue lighter": these are
  /// the values programs were tuned against, and inventing them from the first
  /// eight is how a diff ends up unreadable.
  private static let ansi: [UInt32] = [
    0x00_00_00, 0xcd_00_00, 0x00_cd_00, 0xcd_cd_00, 0x00_00_ee, 0xcd_00_cd, 0x00_cd_cd, 0xe5_e5_e5,
    0x7f_7f_7f, 0xff_00_00, 0x00_ff_00, 0xff_ff_00, 0x5c_5c_ff, 0xff_00_ff, 0x00_ff_ff, 0xff_ff_ff,
  ]

  static func color(_ color: VTColor, fallback: UIColor) -> UIColor {
    switch color {
    case .default: return fallback
    case .rgb(let r, let g, let b):
      return UIColor(
        red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    case .indexed(let index): return indexed(index)
    }
  }

  /// The 256-colour cube, in the one layout every terminal agrees on: sixteen
  /// named, a 6x6x6 cube, then a 24-step grey ramp.
  static func indexed(_ index: UInt8) -> UIColor {
    if index < 16 { return solid(ansi[Int(index)]) }
    if index < 232 {
      let offset = Int(index) - 16
      let steps: [CGFloat] = [0, 95, 135, 175, 215, 255]
      return UIColor(
        red: steps[offset / 36] / 255,
        green: steps[(offset % 36) / 6] / 255,
        blue: steps[offset % 6] / 255,
        alpha: 1)
    }
    let level = CGFloat(8 + (Int(index) - 232) * 10) / 255
    return UIColor(red: level, green: level, blue: level, alpha: 1)
  }

  /// Foreground and background for a cell, with `inverse` and `dim` already
  /// applied - resolved here rather than at the draw site so a run's two
  /// colours are decided exactly once.
  static func resolve(_ style: VTStyle) -> (fg: UIColor, bg: UIColor?) {
    var fg = color(style.fg, fallback: foreground)
    var bg = style.bg == .default ? nil : color(style.bg, fallback: .clear)
    if style.inverse {
      // The background is the ground the row sits on when the program never set
      // one, and inverting against "nothing" has to pick something: the
      // foreground, which is what the unset background is the absence of.
      let ground = bg ?? UIColor.clear
      bg = fg
      fg = style.bg == .default ? resolvedBackground : ground
    }
    if style.dim { fg = fg.withAlphaComponent(0.6) }
    return (fg, bg)
  }

  /// What "inverse with no background set" inverts to. The view's own ground,
  /// spelled here so the two cannot drift.
  static var resolvedBackground: UIColor { .systemBackground }

  private static func solid(_ rgb: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((rgb >> 16) & 0xff) / 255,
      green: CGFloat((rgb >> 8) & 0xff) / 255,
      blue: CGFloat(rgb & 0xff) / 255,
      alpha: 1)
  }

  private static func dynamic(dark: UInt32, light: UInt32) -> UIColor {
    UIColor { traits in solid(traits.userInterfaceStyle == .dark ? dark : light) }
  }
}
