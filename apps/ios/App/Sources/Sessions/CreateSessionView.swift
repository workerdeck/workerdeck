import WorkerDeckKit
import SwiftUI

/// Start a session. Everything past cwd has a sane default, so the fast path is
/// "tap a recent directory, tap Start"; the rest lives behind Advanced.
struct CreateSessionView: View {
  @Environment(HostContext.self) private var context
  @Environment(\.dismiss) private var dismiss

  /// The form's modal pickers, one at a time.
  private enum Sheet: String, Identifiable {
    case folder, model, mode, resumeSession
    var id: String { rawValue }
  }

  @State private var model: CreateSessionModel
  @State private var showAdvanced = false
  @State private var sheet: Sheet?
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
        HStack(spacing: 8) {
          TextField("/Users/you/projects/app", text: $model.cwd)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.callout.monospaced())
          // Typing an absolute path on a phone is the worst part of this form.
          // The picker browses the server's roots; the field stays authoritative,
          // so a path that isn't browsable can still be entered by hand.
          Button {
            sheet = .folder
          } label: {
            Image(systemName: "folder")
          }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
          .accessibilityLabel("Browse folders")
        }
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

      // Both of these open the same pickers the session screen uses, so a mode
      // means the same thing (and looks the same) before a session exists as
      // after one does.
      Section("Permissions") {
        PickerRow(label: "Mode", value: model.permissionMode.label) { sheet = .mode }
      }

      Section("Model") {
        if !model.claudeModels.isEmpty {
          PickerRow(label: "Model", value: model.modelLabel) { sheet = .model }
        } else if model.modelOptions.isEmpty {
          // No list to offer: an engine that ships no catalog and a profile
          // that declares no ids. The id still has to be typeable.
          TextField("Profile default", text: $model.model)
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
        // Present exactly when the record (or the chosen catalog row) offers
        // efforts — never a control that silently does nothing.
        if !model.effortOptions.isEmpty {
          Picker("Effort", selection: $model.reasoningEffort) {
            Text("Default").tag("")
            ForEach(model.effortOptions, id: \.self) { effort in
              Text(effort).tag(effort)
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
          // Sections the capability record forswears are hidden, not disabled:
          // an affordance the engine has no meaning for is not a choice.
          if model.capabilities.settingSources {
            Toggle("User settings", isOn: $model.useUserSettings)
            Toggle("Project settings", isOn: $model.useProjectSettings)
            Toggle("Local settings", isOn: $model.useLocalSettings)
          }
          Toggle("Stream partial messages", isOn: $model.includePartialMessages)
          if model.capabilities.budgets {
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
          }
          if model.capabilities.resume {
            HStack(spacing: 8) {
              TextField("Resume session id", text: $model.resume)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.caption.monospaced())
              // Typing a stored id on a phone is as bad as typing a path, and
              // the same answer applies: the picker lists what the server's
              // disk holds, the field stays authoritative, so an id from
              // anywhere else can still be pasted.
              if model.capabilities.listSessions {
                Button {
                  sheet = .resumeSession
                } label: {
                  Image(systemName: "clock.arrow.circlepath")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
                .accessibilityLabel("Browse stored sessions")
              }
            }
            if model.engine == .claude {
              Toggle("Fork instead of continue", isOn: $model.forkSession)
                .disabled(model.resume.trimmingCharacters(in: .whitespaces).isEmpty)
            }
          }
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
    .sheet(item: $sheet) { sheet in
      switch sheet {
      case .folder:
        FolderPickerView(client: model.fileClient) { path in
          model.cwd = path
        }
      case .model:
        ModelPickerSheet(
          models: model.claudeModels,
          current: model.model.isEmpty ? nil : model.model,
          defaultModel: model.defaultModel,
          onSelect: { model.model = $0 ?? "" })
      case .resumeSession:
        StoredSessionPickerView(model: model)
      case .mode:
        ModePickerSheet(
          modes: model.availableModes,
          current: model.permissionMode,
          defaultMode: model.selectedProfile?.defaults?.permissionMode ?? .default,
          // Creating a session is exactly when bypass *can* be chosen — the CLI
          // only refuses to switch into it later. A server that forbids it
          // outright says so when the request lands.
          canBypass: true,
          onSelect: { model.permissionMode = $0 })
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

/// Pick a stored SDK session to resume — the rows the sessions list's Resume
/// tab draws, but scoped to this form: the cwd field's directory (blank lists
/// the whole store) and the chosen profile's engine store. Picking one fills
/// the id field (and adopts the thread's directory); both stay editable.
private struct StoredSessionPickerView: View {
  let model: CreateSessionModel

  @Environment(\.dismiss) private var dismiss
  @State private var summaries: [SdkSessionSummary]?
  @State private var errorText: String?

  var body: some View {
    NavigationStack {
      Group {
        if let errorText {
          ContentUnavailableView {
            Label("Couldn't list sessions", systemImage: "exclamationmark.triangle")
          } description: {
            Text(errorText)
          } actions: {
            Button("Try again") { Task { await load() } }
          }
        } else if let summaries {
          if summaries.isEmpty {
            ContentUnavailableView {
              Label("Nothing to resume", systemImage: "clock.arrow.circlepath")
            } description: {
              Text(
                model.cwd.trimmingCharacters(in: .whitespaces).isEmpty
                  ? "No stored sessions on this server."
                  : "No stored sessions for this directory. Clear the working directory to list every stored session.")
            }
          } else {
            List(summaries) { summary in
              Button {
                model.adoptStoredSession(summary)
                dismiss()
              } label: {
                SdkSessionRowView(summary: summary)
              }
              .buttonStyle(.plain)
            }
            .listStyle(.plain)
          }
        } else {
          ProgressView()
        }
      }
      .navigationTitle("Resume session")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .task { await load() }
  }

  private func load() async {
    errorText = nil
    summaries = nil
    do {
      summaries = try await model.loadResumeCandidates()
    } catch {
      errorText = SessionListModel.describe(error)
    }
  }
}

/// A form row that opens a picker sheet: label, current value, chevron. Shaped
/// like a `Picker` row so the form reads as one thing.
private struct PickerRow: View {
  let label: String
  let value: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack {
        Text(label)
          .foregroundStyle(.primary)
        Spacer(minLength: 8)
        Text(value)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
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
        .foregroundStyle(profile.isUnavailable ? .secondary : .primary)
      Text(profile.resolvedEngine.rawValue)
        .font(.caption2)
        .foregroundStyle(.secondary)
      // Greyed, never hidden: availability is display-only and the probe can
      // be stale — the row stays selectable.
      if profile.isUnavailable {
        Text("unavailable")
          .font(.caption2)
          .foregroundStyle(.orange)
      }
    }
  }
}
