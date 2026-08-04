import WorkerDeckKit
import SwiftUI

/// Start a session. Everything past cwd has a sane default, so the fast path is
/// "tap a recent directory, tap Start"; the rest lives behind Advanced.
struct CreateSessionView: View {
  @Environment(HostContext.self) private var context
  @Environment(\.dismiss) private var dismiss

  @State private var model: CreateSessionModel
  @State private var showAdvanced = false
  private let onCreated: (SessionInfo) -> Void

  init(seed: CreateSessionSeed, client: WorkerClient, onCreated: @escaping (SessionInfo) -> Void) {
    _model = State(initialValue: CreateSessionModel(seed: seed, client: client))
    self.onCreated = onCreated
  }

  var body: some View {
    @Bindable var model = model
    Form {
      if let message = model.errorMessage {
        Section {
          ErrorBanner(message: message, hint: nil)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
      }

      Section {
        TextField("/Users/you/projects/app", text: $model.cwd)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.callout.monospaced())
        if !context.recentCwds.isEmpty {
          RecentCwdChips(paths: context.recentCwds) { model.cwd = $0 }
        }
      } header: {
        Text("Working directory")
      }

      if model.showsProfilePicker {
        Section("Profile") {
          Picker("Profile", selection: $model.profileName) {
            ForEach(model.profiles) { profile in
              ProfileLabel(profile: profile).tag(Optional(profile.name))
            }
          }
          .onChange(of: model.profileName) { _, _ in model.applyProfileDefaults() }
        }
      }

      Section("Permissions") {
        Picker("Mode", selection: $model.permissionMode) {
          ForEach(model.availableModes, id: \.self) { mode in
            Text(mode.label).tag(mode)
          }
        }
      }

      Section("Model") {
        if model.modelOptions.isEmpty {
          TextField("Server default", text: $model.model)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } else {
          Picker("Model", selection: $model.model) {
            Text("Profile default").tag("")
            ForEach(model.modelOptions, id: \.self) { option in
              Text(option).tag(option)
            }
          }
        }
      }

      Section {
        TextField("Ask for something, or leave blank", text: $model.prompt, axis: .vertical)
          .lineLimit(3...8)
      } header: {
        Text("Initial prompt")
      } footer: {
        Text("Optional. Slash commands work here too, e.g. `/wrapup`.")
      }

      Section {
        DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
          Toggle("User settings", isOn: $model.useUserSettings)
          Toggle("Project settings", isOn: $model.useProjectSettings)
          Toggle("Local settings", isOn: $model.useLocalSettings)
          Toggle("Stream partial messages", isOn: $model.includePartialMessages)
          LabeledContent("Max turns") {
            TextField("unlimited", text: $model.maxTurns)
              .keyboardType(.numberPad)
              .multilineTextAlignment(.trailing)
          }
          LabeledContent("Max budget (USD)") {
            TextField("unlimited", text: $model.maxBudgetUsd)
              .keyboardType(.decimalPad)
              .multilineTextAlignment(.trailing)
          }
          TextField("Resume SDK session id", text: $model.resume)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.caption.monospaced())
          Toggle("Fork instead of continue", isOn: $model.forkSession)
            .disabled(model.resume.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      }
    }
    .navigationTitle(model.resume.isEmpty ? "New session" : "Resume session")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        if model.isSubmitting {
          ProgressView()
        } else {
          Button("Start") {
            Task {
              if let info = await model.submit() { onCreated(info) }
            }
          }
          .disabled(!model.canSubmit)
        }
      }
    }
    .task {
      await model.loadProfiles()
      // Arriving from Resume: the advanced section holds the pre-filled ids, so
      // open it rather than hide what the user is about to act on.
      if !model.resume.isEmpty { showAdvanced = true }
    }
  }
}

/// Tappable recents. Horizontally scrolling so a long path list never wraps the
/// form into a wall of text.
private struct RecentCwdChips: View {
  let paths: [String]
  let onSelect: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(paths, id: \.self) { path in
          Button {
            onSelect(path)
          } label: {
            Text(Fmt.lastComponent(path))
              .font(.caption)
              .padding(.horizontal, 10)
              .padding(.vertical, 5)
              .background(Color.secondary.opacity(0.14), in: Capsule())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(path)
        }
      }
      .padding(.vertical, 2)
    }
    .scrollClipDisabled()
  }
}

private struct ProfileLabel: View {
  let profile: ProfileInfo

  var body: some View {
    HStack(spacing: 6) {
      Text(profile.name)
      Text(profile.resolvedEngine.rawValue)
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }
}
