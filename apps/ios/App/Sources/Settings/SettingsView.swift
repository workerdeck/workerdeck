import SwiftUI
import WorkerDeckActivity

/// App-wide preferences.
///
/// Presented as a sheet from the session list, so the settings that shape every
/// transcript are reachable without being inside one — they are not a property of
/// the session you happen to have open.
struct SettingsView: View {
  @Environment(AppSettings.self) private var settings
  @Environment(\.dismiss) private var dismiss
  #if DEBUG
    @State private var debugStatus: String?
  #endif

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
        Text("Sessions")
      } footer: {
        Text(
          "Reopening a session marks where you left off: a recap of what happened, the rows you had already read faded, and a bar that counts the new ones and jumps to them. Off if you switch between sessions constantly and the marker is just noise."
        )
      }

      Section {
        Picker("Approve from the lock screen", selection: $settings.approveWhileLocked) {
          ForEach(ApproveWhileLocked.allCases, id: \.self) { Text($0.label).tag($0) }
        }
      } header: {
        Text("Live Activities")
      } footer: {
        Text(
          "A running session shows a card on the lock screen and in the Dynamic Island. Its Deny button always works. Approve is the one that can let an agent write to your machine, and unlike a notification's Approve, iOS cannot ask for Face ID first — so by default it waits until the phone is unlocked."
        )
      }

      #if DEBUG
        Section {
          Button("Raise a running card") { debugStatus = ActivityDebug.raise(phase: SessionActivityPhase.running) }
          Button("Raise an approval card") { debugStatus = ActivityDebug.raise(phase: SessionActivityPhase.approval) }
          Button("Raise a question card") { debugStatus = ActivityDebug.raise(phase: SessionActivityPhase.question) }
          Button("Show active cards") { debugStatus = ActivityDebug.inventory() }
          Button("Show card trail") { debugStatus = ActivityTrail.read() }
          Button("Clear trail") {
            ActivityTrail.clear()
            debugStatus = "trail cleared"
          }
          Button("End every card", role: .destructive) {
            Task {
              await ActivityDebug.endAll()
              debugStatus = "Ended every card."
            }
          }
          if let debugStatus {
            Text(debugStatus).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
          }
        } header: {
          Text("Live Activities (debug)")
        } footer: {
          Text(
            "Starts a card locally, with no gateway and no APNs — the only way to see these layouts in the Simulator, and the cheapest way to check on a device that a card's buttons run their intent in the app process."
          )
        }
      #endif
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
