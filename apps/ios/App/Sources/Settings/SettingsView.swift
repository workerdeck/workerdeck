import SwiftUI

/// App-wide preferences.
///
/// Presented as a sheet from the session list, so the settings that shape every
/// transcript are reachable without being inside one — they are not a property of
/// the session you happen to have open.
struct SettingsView: View {
  @Environment(AppSettings.self) private var settings
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    @Bindable var settings = settings

    Form {
      Section {
        Picker("Style", selection: $settings.transcriptVariant) {
          ForEach(TranscriptVariant.allCases, id: \.self) { variant in
            Text(variant.label).tag(variant)
          }
        }
        Picker("Density", selection: $settings.transcriptDensity) {
          ForEach(TranscriptDensity.allCases, id: \.self) { density in
            Text(density.label).tag(density)
          }
        }
        Picker("Font", selection: $settings.transcriptFont) {
          ForEach(TranscriptFont.allCases, id: \.self) { font in
            Text(font.label).tag(font)
          }
        }
      } header: {
        Text("Agent view")
      } footer: {
        Text(explanation)
      }
    }
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Done") { dismiss() }
      }
    }
  }

  /// Says what each choice does rather than naming it twice — "Cards" and
  /// "Lines" mean nothing until you've seen both.
  private var explanation: String {
    let style =
      switch settings.transcriptVariant {
      case .cards: "Cards puts your messages in bubbles and boxes each tool call."
      case .lines: "Lines draws every event as a full-width row behind a marker, like a terminal."
      }
    let density =
      switch settings.transcriptDensity {
      case .comfortable: "Comfortable leaves a blank line between rows."
      case .compact: "Compact closes the gaps."
      }
    let font =
      switch settings.transcriptFont {
      case .regular: "Regular is the system font."
      case .monospace: "Monospace puts the whole agent view in the code font."
      }
    // Says what applies where, once: these three shape a session you have open
    // and nothing else in the app.
    return "\(style) \(density) \(font) These apply to the agent view only."
  }
}
