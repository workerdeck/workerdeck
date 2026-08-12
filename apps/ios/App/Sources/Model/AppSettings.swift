import SwiftUI

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

  private let defaults: UserDefaults

  private static let variantKey = "bi.atomic.workerdeck.ios.transcriptVariant"
  private static let densityKey = "bi.atomic.workerdeck.ios.transcriptDensity"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    // Defaults match the web dashboard's, so a reader moving between the two
    // sees the same transcript until they say otherwise.
    transcriptVariant =
      defaults.string(forKey: Self.variantKey).flatMap(TranscriptVariant.init(rawValue:)) ?? .cards
    transcriptDensity =
      defaults.string(forKey: Self.densityKey).flatMap(TranscriptDensity.init(rawValue:))
      ?? .comfortable
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

extension EnvironmentValues {
  var transcriptVariant: TranscriptVariant {
    get { self[TranscriptVariantKey.self] }
    set { self[TranscriptVariantKey.self] = newValue }
  }

  var transcriptDensity: TranscriptDensity {
    get { self[TranscriptDensityKey.self] }
    set { self[TranscriptDensityKey.self] = newValue }
  }
}

extension TranscriptVariant {
  /// True in `lines`, for the many `cond ? a : b` reads in the row views.
  var isLines: Bool { self == .lines }
}

extension View {
  /// Both reader preferences in one modifier. They always travel together, and
  /// `SessionView`'s body is long enough that two more links in its chain put it
  /// over the type-checker's budget.
  func transcriptPreferences(_ settings: AppSettings) -> some View {
    environment(\.transcriptVariant, settings.transcriptVariant)
      .environment(\.transcriptDensity, settings.transcriptDensity)
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
