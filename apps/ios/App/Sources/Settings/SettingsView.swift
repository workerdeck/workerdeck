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
        // Density and font are Cards-only: Terminal has one line height and is
        // monospace by construction, so neither choice has anything to change
        // there. Disabled rather than hidden — the row stays in place so picking
        // Terminal and back doesn't reflow the form, but a control that changes
        // nothing is worse than an absent one, hence the footer saying so.
        Picker("Density", selection: $settings.transcriptDensity) {
          ForEach(TranscriptDensity.allCases, id: \.self) { density in
            Text(density.label).tag(density)
          }
        }
        .disabled(settings.transcriptVariant.isTerminal)
        Picker("Font", selection: $settings.transcriptFont) {
          ForEach(TranscriptFont.allCases, id: \.self) { font in
            Text(font.label).tag(font)
          }
        }
        .disabled(settings.transcriptVariant.isTerminal)
      } header: {
        Text("Agent view")
      } footer: {
        Text(explanation)
      }

      Section {
        Toggle("Catch-up mode", isOn: $settings.catchUpMode)
      } header: {
        Text("Messages")
      } footer: {
        Text(
          "Send a message you type while a turn is running into that running turn. Off holds it until the turn ends."
        )
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
  /// "Terminal" mean nothing until you've seen both.
  private var explanation: String {
    let style =
      switch settings.transcriptVariant {
      case .cards: "Cards puts your messages in bubbles and boxes each tool call."
      case .terminal: "Terminal draws the transcript like a CLI session, in one monospaced size."
      }
    // Terminal's line saying they don't apply replaces the density/font
    // sentences entirely, rather than joining them: a sentence explaining a
    // disabled control is more useful than the control's own (inert) wording.
    guard !settings.transcriptVariant.isTerminal else {
      return "\(style) Density and font are fixed under Terminal."
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
