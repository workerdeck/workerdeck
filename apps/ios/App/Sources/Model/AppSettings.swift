import SwiftUI
import UIKit

/// How the transcript draws a turn — the Swift mirror of the web `ui` package's
/// `TranscriptVariant` (`packages/ui/src/components/agent/transcript-variant.tsx`).
///
/// - `cards` — the chat convention: a bubble for what you typed, bordered tool
///   cards, generous gaps.
/// - `terminal` — the CLI's own shape, drawn by its own renderer
///   (`Session/Terminal/`) rather than by branches in the `cards` views: one
///   line height, monospace by construction, a fixed glyph gutter instead of
///   boxes. Nothing under `TranscriptItemView`/`Markdown` asks which variant it
///   is in any more — if it is drawing, it is drawing cards.
enum TranscriptVariant: String, Codable, CaseIterable, Sendable {
  case cards
  case terminal

  var label: String {
    switch self {
    case .cards: "Cards"
    case .terminal: "Terminal"
    }
  }
}

/// How much room the transcript gives each row.
///
/// **Cards-only.** Terminal has one line height and is monospace by
/// construction, so there is no "how much air around a row" to prefer — its
/// spacing is a blank *line* decided per pair of blocks, not a container gap
/// (see `transcriptRowGap` below). A control that changed nothing under
/// terminal would invite pressing it for no effect, so callers must hide or
/// disable these when the variant is terminal (`SettingsView`).
enum TranscriptDensity: String, Codable, CaseIterable, Sendable {
  case comfortable
  case compact

  var label: String {
    switch self {
    case .comfortable: "Comfortable"
    case .compact: "Compact"
    }
  }
}

/// The typeface the agent view runs in — the Swift mirror of `SessionPanel`'s
/// `transcriptFont`.
///
/// `monospace` applies to a **running session and nothing else**: the session
/// list, the settings sheet and every other screen keep the system font, because
/// the claim is a monospace agent view inside an ordinary app rather than a
/// monospace app.
///
/// **Cards-only**, like density: terminal is monospace by construction (it
/// takes its face from the terminal renderer's own cell font), so this choice
/// has nothing to apply to there.
enum TranscriptFont: String, Codable, CaseIterable, Sendable {
  case regular
  case monospace

  var label: String {
    switch self {
    case .regular: "Regular"
    case .monospace: "Monospace"
    }
  }

  /// What SwiftUI wants. `nil` leaves the inherited design alone rather than
  /// asserting `.default` over it.
  var design: Font.Design? {
    switch self {
    case .regular: nil
    case .monospace: .monospaced
    }
  }

  /// What UIKit wants. The composer's field is a `UITextView`, which sits
  /// outside SwiftUI's font environment and has to be told (see `DraftStyle`).
  var uiDesign: UIFontDescriptor.SystemDesign {
    switch self {
    case .regular: .default
    case .monospace: .monospaced
    }
  }
}

/// Process-wide reader preferences, persisted to `UserDefaults`.
///
/// One object for the whole app rather than a per-session choice: how a
/// transcript should read is a property of the reader, not of the session being
/// read. Follows the house pattern (`SessionListModel.config`) — `@Observable`,
/// injected defaults, `didSet` persist — rather than `@AppStorage`, so the
/// storage stays testable and the keys stay namespaced in one place.
@MainActor
@Observable
final class AppSettings {
  var transcriptVariant: TranscriptVariant {
    didSet { defaults.set(transcriptVariant.rawValue, forKey: Self.variantKey) }
  }

  var transcriptDensity: TranscriptDensity {
    didSet { defaults.set(transcriptDensity.rawValue, forKey: Self.densityKey) }
  }

  var transcriptFont: TranscriptFont {
    didSet { defaults.set(transcriptFont.rawValue, forKey: Self.fontKey) }
  }

  /// Catch-up mode: whether a message typed mid-turn is sent into the running
  /// turn (the engine folds it in) or held until the turn ends. On by default,
  /// matching every other client — the engine's own behaviour is the one nobody
  /// had to ask for.
  var catchUpMode: Bool {
    didSet { defaults.set(catchUpMode, forKey: Self.catchUpKey) }
  }

  private let defaults: UserDefaults

  private static let variantKey = "bi.atomic.workerdeck.ios.transcriptVariant"
  private static let densityKey = "bi.atomic.workerdeck.ios.transcriptDensity"
  private static let fontKey = "bi.atomic.workerdeck.ios.transcriptFont"
  private static let catchUpKey = "bi.atomic.workerdeck.ios.catchUpMode"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    // Defaults match the web dashboard's, so a reader moving between the two
    // sees the same transcript until they say otherwise.
    // A stored "lines" predates the `terminal` renderer and migrates to it
    // rather than falling back to the `cards` default: someone who turned
    // boxes off should keep them off, not be silently opted back into cards.
    switch defaults.string(forKey: Self.variantKey) {
    case "lines": transcriptVariant = .terminal
    case let raw?: transcriptVariant = TranscriptVariant(rawValue: raw) ?? .cards
    case nil: transcriptVariant = .cards
    }
    transcriptDensity =
      defaults.string(forKey: Self.densityKey).flatMap(TranscriptDensity.init(rawValue:))
      ?? .comfortable
    transcriptFont =
      defaults.string(forKey: Self.fontKey).flatMap(TranscriptFont.init(rawValue:)) ?? .regular
    catchUpMode = defaults.object(forKey: Self.catchUpKey) as? Bool ?? true
  }
}

// MARK: - Environment

/// Variant and density reach the rows as environment values rather than props.
/// Every row kind needs them and only the transcript root knows them; threading
/// two parameters through seven row types (and the markdown blocks below those)
/// to reach a background colour is worse than one lookup. Same reasoning — and
/// the same shape — as `\.fileDownloader` and `\.producedImageLoader`.
private struct TranscriptVariantKey: EnvironmentKey {
  static let defaultValue: TranscriptVariant = .cards
}

private struct TranscriptDensityKey: EnvironmentKey {
  static let defaultValue: TranscriptDensity = .comfortable
}

private struct TranscriptFontKey: EnvironmentKey {
  static let defaultValue: TranscriptFont = .regular
}

extension EnvironmentValues {
  var transcriptVariant: TranscriptVariant {
    get { self[TranscriptVariantKey.self] }
    set { self[TranscriptVariantKey.self] = newValue }
  }

  var transcriptDensity: TranscriptDensity {
    get { self[TranscriptDensityKey.self] }
    set { self[TranscriptDensityKey.self] = newValue }
  }

  var transcriptFont: TranscriptFont {
    get { self[TranscriptFontKey.self] }
    set { self[TranscriptFontKey.self] = newValue }
  }
}

extension TranscriptVariant {
  /// True in `terminal`, for the chrome that sits *beside* the transcript
  /// (composer, status bar) rather than inside it — those still need to know
  /// which shape they're docking against, even though the rows themselves no
  /// longer branch on this.
  var isTerminal: Bool { self == .terminal }
}

extension View {
  /// All three reader preferences in one modifier. They always travel together,
  /// and `SessionView`'s body is long enough that another few links in its chain
  /// put it over the type-checker's budget.
  ///
  /// The font is applied here as well as published: `fontDesign` is inherited by
  /// every `Text` below, which is the whole mechanism — the same one-attribute,
  /// let-the-cascade-do-it trick `SessionPanel` plays with `data-agent-font`. It
  /// is scoped to whatever this modifier is attached to, so a monospace agent
  /// view cannot leak into the list you reached it from.
  func transcriptPreferences(_ settings: AppSettings) -> some View {
    environment(\.transcriptVariant, settings.transcriptVariant)
      .environment(\.transcriptDensity, settings.transcriptDensity)
      .environment(\.transcriptFont, settings.transcriptFont)
      .fontDesign(settings.transcriptFont.design)
  }
}

/// The composer's own text size when the docked (terminal) shape is in force —
/// the UIKit vocabulary, for the `UITextView` that sits outside SwiftUI's font
/// environment and has to be told (see `DraftStyle`, `RichTextEditor`). The rest
/// of the `lines` variant's one-size rule died with `lines` itself: the
/// terminal transcript now draws its own rows in `Session/Terminal/`, at its own
/// cell size, and does not route through here. This one survives because the
/// composer is chrome *beside* the transcript, not a transcript row, and a field
/// set two points larger than the terminal transcript above it would read as a
/// different app's input box.
let lineTextUIStyle: UIFont.TextStyle = .subheadline

/// The gap between two `cards` rows, per density — the whole of the density
/// feature, since `TranscriptListView`'s `LazyVStack` spacing is the only
/// vertical separation between rows that exists.
///
/// Terminal returns 0 unconditionally: its rows are one line height apart by
/// construction, and the blank line that separates *blocks* (not rows) is drawn
/// per pair of blocks inside the terminal renderer itself, not by a container
/// gap here — mirroring the web `ui` package, where density "reaches `cards`
/// only" for the same reason.
func transcriptRowGap(_ variant: TranscriptVariant, _ density: TranscriptDensity) -> CGFloat {
  switch variant {
  case .cards:
    switch density {
    case .comfortable: 12
    case .compact: 6
    }
  case .terminal:
    0
  }
}
