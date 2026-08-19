import SwiftUI
import UIKit
import WorkerDeckKit

/// The terminal theme's palette, one spelling for the whole app.
///
/// Ported value-for-value from `packages/ui/src/styles/terminal.css`, so a
/// session read on the phone and the same session read in the dashboard are the
/// same colours — which matters more than it sounds: the tones carry meaning
/// (green is "this changed the workspace", yellow is "waiting on you"), and a
/// client that shaded them differently would be saying something different.
///
/// Resolved through `UIColor(dynamicProvider:)` rather than an asset catalog
/// because these are not brand colours to be tweaked by a designer — they are
/// the ANSI-ish vocabulary of the theme, and they belong beside the code that
/// draws with them.
///
/// Every token is a **`UIColor` first** and a SwiftUI `Color` derived from it.
/// The terminal transcript draws by hand now — a text run, a gutter and a band
/// per line, all in UIKit — and a token that existed only as a `Color` would
/// have to be bridged at every draw, on the hottest path there is.
enum TerminalPalette {
  static func color(_ tone: TermTone) -> Color { Color(uiColor: uiColor(tone)) }
  static func band(_ band: TermBand) -> Color { Color(uiColor: uiBand(band)) }
  static var openWash: Color { Color(uiColor: uiOpenWash) }
  static var nestedRule: Color { Color(uiColor: uiNestedRule) }

  static func uiColor(_ tone: TermTone) -> UIColor {
    switch tone {
    // Body text is a light grey, *not* white: white is reserved for emphasis,
    // and a transcript set entirely in it has nothing left to emphasise with.
    case .fg: return dynamic(dark: 0xd4_d4_d4, light: 0x2f_2f_2f)
    case .bright: return dynamic(dark: 0xff_ff_ff, light: 0x00_00_00)
    // Markers, meta, tool output.
    case .dim: return dynamic(dark: 0x8a_8a_8a, light: 0x6b_6b_6b)
    // One step down again: hints, "+N", rules.
    case .faint: return dynamic(dark: 0x6a_6a_6a, light: 0x8d_8d_8d)
    // The working pulse — the brand coral, and the only place it appears.
    case .mark: return dynamic(dark: 0xd9_77_57, light: 0xbf_5b_3d)
    case .blue: return dynamic(dark: 0xaf_b9_fe, light: 0x0a_66_c2)
    case .green: return dynamic(dark: 0x4e_c9_a0, light: 0x16_79_4a)
    case .red: return dynamic(dark: 0xf1_4c_4c, light: 0xc6_28_28)
    case .yellow: return dynamic(dark: 0xd7_ba_7d, light: 0x8a_6d_00)
    case .magenta: return dynamic(dark: 0xc5_86_c0, light: 0x8b_3a_8b)
    case .diffAdd: return dynamic(dark: 0xb5_e8_a9, light: 0x12_49_2a)
    case .diffRemove: return dynamic(dark: 0xf0_a6_a6, light: 0x7a_1f_24)
    case .diffContext: return dynamic(dark: 0x9a_9a_9a, light: 0x4a_4a_4a)
    case .diffNumber: return dynamic(dark: 0x5a_5a_5a, light: 0x9a_9a_9a)
    }
  }

  /// The wash behind a line. Alpha, never a flat colour: a row sits on whatever
  /// its host paints, and a value tuned against one ground is invisible on
  /// another.
  static func uiBand(_ band: TermBand) -> UIColor {
    switch band {
    case .none: return .clear
    case .output: return dynamicAlpha(dark: 0.04, light: 0.04)
    case .user: return dynamicAlpha(dark: 0.05, light: 0.05)
    case .diffAdd: return dynamic(dark: 0x16_30_1a, light: 0xe2_f6_e5)
    case .diffRemove: return dynamic(dark: 0x3a_15_18, light: 0xfb_e6_e7)
    }
  }

  /// The wash behind an **open** block, so eighty lines that appeared at once
  /// read as one block rather than as the transcript having grown. The web
  /// client's `--term-row-hover`, which is where a pointer-driven surface also
  /// spends it — there is no hover here, so it is free.
  static var uiOpenWash: UIColor { dynamicAlpha(dark: 0.05, light: 0.04) }

  /// Behind a line a press would act on. Deliberately below the open wash
  /// (0.05/0.04) and the bands (0.04/0.05): this is a hint about what a finger
  /// can do, not a state the row is in, and a transcript is mostly pressable —
  /// at band strength every second row would be washed and the ones that carry
  /// real meaning would stop standing out.
  static var uiPressable: UIColor { dynamicAlpha(dark: 0.028, light: 0.024) }

  /// The rule drawn *inside* a nested row's padding, so the indent stays exactly
  /// two cells — a border would be layout, and would take every subagent row
  /// half a character off the column its parent sits on.
  static var uiNestedRule: UIColor {
    dynamic(dark: 0x6a_6a_6a, light: 0x8d_8d_8d).withAlphaComponent(0.5)
  }

  private static func dynamic(dark: UInt32, light: UInt32) -> UIColor {
    UIColor { traits in
      traits.userInterfaceStyle == .dark ? rgb(dark) : rgb(light)
    }
  }

  private static func dynamicAlpha(dark: CGFloat, light: CGFloat) -> UIColor {
    UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(white: 1, alpha: dark) : UIColor(white: 0, alpha: light)
    }
  }

  private static func rgb(_ value: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255, alpha: 1)
  }
}
