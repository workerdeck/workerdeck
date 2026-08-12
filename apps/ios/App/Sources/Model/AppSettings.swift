import SwiftUI
import UIKit

/// How the transcript draws a turn — the Swift mirror of the web `ui` package's
/// `TranscriptVariant` (`packages/ui/src/components/agent/transcript-variant.tsx`).
///
/// - `cards` — the chat convention: a bubble for what you typed, bordered tool
///   cards, generous gaps.
/// - `lines` — one full-width line item per event, transparent, behind a glyph in
///   a fixed left gutter. Nothing is boxed; the content and its marker carry the
///   comprehension.
enum TranscriptVariant: String, Codable, CaseIterable, Sendable {
  case cards
  case lines

  var label: String {
    switch self {
    case .cards: "Cards"
    case .lines: "Lines"
    }
  }
}

/// How much room the transcript gives each row.
///
/// Separate from the variant, and deliberately so: the variant decides *how a row
/// is drawn* (boxed or not) and follows from the surface, while density decides
/// *how much air is around it* and is a preference the reader holds. Coupling
/// them would mean cards could not be dense and lines could not be roomy.
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

  private let defaults: UserDefaults

  private static let variantKey = "bi.atomic.workerdeck.ios.transcriptVariant"
  private static let densityKey = "bi.atomic.workerdeck.ios.transcriptDensity"
  private static let fontKey = "bi.atomic.workerdeck.ios.transcriptFont"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    // Defaults match the web dashboard's, so a reader moving between the two
    // sees the same transcript until they say otherwise.
    transcriptVariant =
      defaults.string(forKey: Self.variantKey).flatMap(TranscriptVariant.init(rawValue:)) ?? .cards
    transcriptDensity =
      defaults.string(forKey: Self.densityKey).flatMap(TranscriptDensity.init(rawValue:))
      ?? .comfortable
    transcriptFont =
      defaults.string(forKey: Self.fontKey).flatMap(TranscriptFont.init(rawValue:)) ?? .regular
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
  /// True in `lines`, for the many `cond ? a : b` reads in the row views.
  var isLines: Bool { self == .lines }
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

/// The one text size every `lines` row uses.
///
/// A terminal has exactly one type size, and that is most of what makes it read
/// like a terminal. `cards` keeps its ramp — a chat surface leans on size to
/// separate a message from its furniture — but in `lines` the gutter glyph does
/// that job already, which frees size to be constant.
///
/// `.subheadline` — one step under the chat variant's `.body`. A terminal's type
/// is small: the whole trade of this variant is fitting more of a run on screen,
/// and at `.callout` the rows were still chat-sized.
let lineTextStyle: Font = .subheadline

/// The same size in UIKit's vocabulary, for the composer's `UITextView` — which
/// is outside SwiftUI's font environment and has to be told (see `DraftStyle`).
/// A field set two points larger than the transcript above it reads as a
/// different app's input box.
let lineTextUIStyle: UIFont.TextStyle = .subheadline

/// A row's text size: the caller's own in `cards`, one constant in `lines`.
///
/// A modifier rather than a computed font at each call site because the variant
/// lives in the environment and most of these call sites are inside views that
/// don't otherwise need to read it.
private struct RowFont: ViewModifier {
  @Environment(\.transcriptVariant) private var variant

  let cards: Font
  let lines: Font

  func body(content: Content) -> some View {
    content.font(variant.isLines ? lines : cards)
  }
}

extension View {
  /// Pass `lines:` only for the few places that must stay *subordinate* to the
  /// row's own text (a chevron, a backend tag) — normalising those to the body
  /// size would make them shout.
  func rowFont(_ cards: Font, lines: Font = lineTextStyle) -> some View {
    modifier(RowFont(cards: cards, lines: lines))
  }
}

/// The gap between two rows, per variant and density — the whole of the density
/// feature, since `TranscriptListView`'s `LazyVStack` spacing is the only
/// vertical separation between rows that exists.
///
/// `lines` + `compact` is the tightest: there the rows sit directly against each
/// other and the glyph gutter alone separates them, which is what makes it
/// compact.
func transcriptRowGap(_ variant: TranscriptVariant, _ density: TranscriptDensity) -> CGFloat {
  switch (variant, density) {
  case (.cards, .comfortable): 12
  case (.cards, .compact): 6
  case (.lines, .comfortable): 10
  case (.lines, .compact): 2
  }
}
