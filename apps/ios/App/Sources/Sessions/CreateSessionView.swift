import WorkerDeckCore
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
  private let onCreated: (Created) -> Void
  private let onAgentCreated: (Created) -> Void

  init(
    form: CreateForm, client: WorkerClient,
    onAgentCreated: @escaping (Created) -> Void = { _ in },
    onCreated: @escaping (Created) -> Void
  ) {
    _model = State(initialValue: CreateSessionModel(form: form, client: client))
    self.onCreated = onCreated
    self.onAgentCreated = onAgentCreated
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

      if model.state.isAgent {
        agentSection(model)
      }

      Section {
        HStack(spacing: 8) {
          TextField("/Users/you/projects/app", text: $model.fields.cwd)
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
          RecentCwdChips(paths: context.recentCwds) { model.fields.cwd = $0 }
        }
      } header: {
        Text("Working directory")
      }

      if model.state.showsProfilePicker {
        Section("Profile") {
          Picker("Profile", selection: $model.fields.profile) {
            ForEach(model.state.profiles, id: \.name) { profile in
              ProfileLabel(profile: profile).tag(Optional(profile.name))
            }
          }
        }
      }

      // Both of these open the same pickers the session screen uses, so a mode
      // means the same thing (and looks the same) before a session exists as
      // after one does.
      Section("Permissions") {
        PickerRow(label: "Mode", value: model.state.modeLabel) { sheet = .mode }
      }

      Section("Model") {
        if model.state.hasCatalog {
          PickerRow(label: "Model", value: model.state.modelLabel) { sheet = .model }
        } else if model.state.modelOptions.isEmpty {
          // No list to offer: an engine that ships no catalog and a profile
          // that declares no ids. The id still has to be typeable.
          TextField("Profile default", text: $model.fields.model)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } else {
          Picker("Model", selection: $model.fields.model) {
            Text("Profile default").tag("")
            ForEach(model.state.modelOptions, id: \.self) { option in
              Text(option).tag(option)
            }
          }
        }
        // Present exactly when the record (or the chosen catalog row) offers
        // efforts - never a control that silently does nothing.
        if !model.state.effortOptions.isEmpty {
          Picker("Effort", selection: $model.fields.reasoningEffort) {
            Text("Default").tag("")
            ForEach(model.state.effortOptions, id: \.self) { effort in
              Text(effort).tag(effort)
            }
          }
        }
      }

      Section {
        TextField("Ask for something, or leave blank", text: $model.fields.prompt, axis: .vertical)
          .lineLimit(3...8)
      } header: {
        Text("Initial prompt")
      } footer: {
        Text("Optional. Slash commands work here too, e.g. `/wrapup`.")
      }

      if !model.state.isAgent {
      Section {
        DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
          // Sections the capability record forswears are hidden, not disabled:
          // an affordance the engine has no meaning for is not a choice.
          if model.state.settingSources {
            Toggle("User settings", isOn: $model.fields.userSettings)
            Toggle("Project settings", isOn: $model.fields.projectSettings)
            Toggle("Local settings", isOn: $model.fields.localSettings)
          }
          Toggle("Stream partial messages", isOn: $model.fields.partialMessages)
          if model.state.budgets {
            LabeledContent("Max turns") {
              TextField("unlimited", text: $model.fields.maxTurns)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
            }
            LabeledContent("Max budget (USD)") {
              TextField("unlimited", text: $model.fields.maxBudgetUsd)
                .keyboardType(.decimalPad)
                .multilineTextAlignment(.trailing)
            }
          }
          if model.state.resume {
            HStack(spacing: 8) {
              TextField("Resume session id", text: $model.fields.resume)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.caption.monospaced())
              // Typing a stored id on a phone is as bad as typing a path, and
              // the same answer applies: the picker lists what the server's
              // disk holds, the field stays authoritative, so an id from
              // anywhere else can still be pasted.
              if model.state.listSessions {
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
            if model.state.showsFork {
              Toggle("Fork instead of continue", isOn: $model.fields.forkSession)
                .disabled(model.fields.resume.trimmingCharacters(in: .whitespaces).isEmpty)
            }
          }
        }
      }
      }
    }
    .navigationTitle(model.state.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        if model.isSubmitting {
          ProgressView()
        } else {
          Button(model.state.submitLabel) {
            Task {
              if model.state.isAgent {
                if let created = await model.submitAgent() { onAgentCreated(created) }
              } else if let created = await model.submit() {
                onCreated(created)
              }
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
          model.fields.cwd = path
        }
      case .model:
        ModelPickerSheet(picker: model.modelPicker, onSelect: { model.fields.model = $0 ?? "" })
      case .resumeSession:
        StoredSessionPickerView(model: model)
      case .mode:
        ModePickerSheet(picker: model.modePicker, onSelect: { model.fields.permissionMode = $0 })
      }
    }
    .task {
      await model.loadProfiles()
      // Arriving from Resume: the advanced section holds the pre-filled ids, so
      // open it rather than hide what the user is about to act on.
      if !model.fields.resume.isEmpty { showAdvanced = true }
    }
  }
}

/// Pick a stored SDK session to resume - the rows the sessions list's Resume
/// tab draws, but scoped to this form: the cwd field's directory (blank lists
/// the whole store) and the chosen profile's engine store. Picking one fills
/// the id field (and adopts the thread's directory); both stay editable.
extension CreateSessionView {
  @ViewBuilder
  fileprivate func agentSection(_ model: CreateSessionModel) -> some View {
    @Bindable var model = model
    Section {
      TextField("Name (the gateway suggests one)", text: $model.fields.agentName)
        .textInputAutocapitalization(.words)
        .autocorrectionDisabled()
      if !model.state.leads.isEmpty {
        Picker("Team", selection: $model.fields.lead) {
          Text("None").tag(String?.none)
          ForEach(model.state.leads, id: \.agentId) { lead in
            Text(lead.name).tag(Optional(lead.agentId))
          }
        }
      }
      if model.state.showsSharing {
        Picker("Sharing", selection: $model.sharing) {
          Text("Private").tag(Sharing.private)
          Text("Shared").tag(Sharing.shared)
        }
      }
    } header: {
      Text("Agent")
    } footer: {
      Text("An agent keeps its name, avatar and team across conversations.")
    }
    Section {
      TextField("Who this agent is and what it works on", text: $model.fields.brief, axis: .vertical)
        .lineLimit(3...8)
    } header: {
      Text("Brief")
    } footer: {
      Text("Optional. Given to the agent as standing instructions in every conversation.")
    }
  }
}

private struct StoredSessionPickerView: View {
  let model: CreateSessionModel

  @Environment(\.dismiss) private var dismiss
  @State private var summaries: [SdkSession]?
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
                model.fields.cwd.trimmingCharacters(in: .whitespaces).isEmpty
                  ? "No stored sessions on this server."
                  : "No stored sessions for this directory. Clear the working directory to list every stored session.")
            }
          } else {
            List(summaries, id: \.sessionId) { summary in
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
  let profile: FormProfile

  var body: some View {
    HStack(spacing: 6) {
      Text(profile.name)
        .foregroundStyle(profile.unavailable ? .secondary : .primary)
      Text(profile.engine)
        .font(.caption2)
        .foregroundStyle(.secondary)
      // Greyed, never hidden: availability is display-only and the probe can
      // be stale - the row stays selectable.
      if profile.unavailable {
        Text("unavailable")
          .font(.caption2)
          .foregroundStyle(.orange)
      }
    }
  }
}
