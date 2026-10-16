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
