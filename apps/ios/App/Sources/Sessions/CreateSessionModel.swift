import WorkerDeckKit
import Foundation
import Observation

/// Form state for `POST /sessions`, kept out of the view so the field
/// interdependencies (profile → engine → legal permission modes → model list) are
/// testable and readable in one place.
@MainActor
@Observable
final class CreateSessionModel {
  // Basics
  var cwd: String
  var profileName: String?
  var permissionMode: PermissionMode = .default
  var model: String = ""
  var prompt: String = ""

  // Advanced
  var useUserSettings = true
  var useProjectSettings = true
  var useLocalSettings = false
  var includePartialMessages = true
  var maxTurns: String = ""
  var maxBudgetUsd: String = ""
  var resume: String
  var forkSession = false
  /// '' = the engine's default. Only sent when the capability record offers it.
  var reasoningEffort: String = ""

  private(set) var profiles: [ProfileInfo] = []
  /// Set when `/profiles` 404s — a server predating profiles, not an error.
  private(set) var profilesUnavailable = false
  private(set) var isLoadingProfiles = false
  private(set) var isSubmitting = false
  private(set) var errorMessage: String?

  private let client: WorkerClient

  init(seed: CreateSessionSeed, client: WorkerClient) {
    cwd = seed.cwd
    resume = seed.resume ?? ""
    // Resuming defaults to continuing, not forking — forking is the deliberate
    // choice ("keep the original intact"), so it stays opt-in.
    self.client = client
  }

  /// The gateway this form posts to, for the folder picker — which browses the
  /// same host filesystem an open session does, only from the roots down rather
  /// than from a cwd that doesn't exist yet.
  var fileClient: WorkerClient { client }

  var selectedProfile: ProfileInfo? {
    profiles.first { $0.name == profileName }
  }

  /// Engine the session will actually run on. Absent profile info reads as claude,
  /// matching `ProfileInfo.resolvedEngine`.
  var engine: ProfileEngine {
    selectedProfile?.resolvedEngine ?? .claude
  }

  /// The capability record the form renders around — the server-stamped copy
  /// when present, else the engine's static default. Never branch on the
  /// engine name for an affordance this record answers.
  var capabilities: EngineCapabilities {
    selectedProfile?.resolvedCapabilities ?? engine.defaultCapabilities
  }

  /// Only the modes this engine understands, in the record's order — offering
  /// the rest would just produce a server-side rejection.
  var availableModes: [PermissionMode] { capabilities.permissionModes }

  /// Model ids the chosen profile advertises. Empty → free-text field.
  var modelOptions: [String] {
    selectedProfile?.provider?.models ?? []
  }

  /// The engine's model catalog, served with the profile from the server's
  /// first response (claude and codex ship one with each release; provider
  /// profiles list ids in `provider.models` instead).
  var claudeModels: [ModelOption] {
    selectedProfile?.models ?? []
  }

  /// Reasoning efforts offerable right now: the chosen catalog row's list when
  /// it declares one, else the record's engine-wide set. Empty hides the
  /// control — never a picker that does nothing.
  var effortOptions: [String] {
    let trimmed = model.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty, let row = claudeModels.first(where: { $0.matches(trimmed) }),
      let efforts = row.reasoningEfforts
    {
      return efforts
    }
    return capabilities.reasoningEfforts ?? []
  }

  /// What the profile's default resolves to, for the picker's DEFAULT tag.
  var defaultModel: String? { selectedProfile?.defaultModel }

  /// The chosen model, named. Empty selection is the profile's own default,
  /// which is a legitimate answer here in a way it never is mid-session: this
  /// form is where "default" is a choice.
  var modelLabel: String {
    let trimmed = model.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return "Profile default" }
    return claudeModels.first { $0.matches(trimmed) }?.displayName ?? trimmed
  }

  /// Hidden when the server offers exactly one profile — there is no choice to make.
  var showsProfilePicker: Bool { profiles.count > 1 }

  var canSubmit: Bool {
    !cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
  }

  func loadProfiles() async {
    guard profiles.isEmpty, !profilesUnavailable else { return }
    isLoadingProfiles = true
    defer { isLoadingProfiles = false }
    do {
      let response = try await client.listProfiles()
      profiles = response.profiles
      if profileName == nil { profileName = response.profiles.first?.name }
      applyProfileDefaults()
    } catch let error as WorkerClientError where error.statusCode == 404 {
      profilesUnavailable = true
    } catch {
      errorMessage = SessionListModel.describe(error)
    }
  }

  /// Adopt the profile's declared defaults, and snap out-of-range choices back
  /// to the capability record's coercion targets — a sticky mode or effort from
  /// another engine must not survive into a request this one would 400.
  func applyProfileDefaults() {
    guard let profile = selectedProfile else { return }
    let capabilities = profile.resolvedCapabilities
    if let defaultModel = profile.defaults?.model, model.isEmpty { model = defaultModel }
    if let defaultMode = profile.defaults?.permissionMode,
      capabilities.permissionModes.contains(defaultMode)
    {
      permissionMode = defaultMode
    } else if !capabilities.permissionModes.contains(permissionMode) {
      permissionMode = capabilities.defaultPermissionMode
    }
    if !modelOptions.isEmpty, !modelOptions.contains(model) {
      model = profile.provider?.model ?? modelOptions[0]
    }
    if !reasoningEffort.isEmpty, !effortOptions.contains(reasoningEffort) {
      reasoningEffort = ""
    }
  }

  /// Create the session. Returns nil (and sets `errorMessage`) on failure.
  func submit() async -> SessionInfo? {
    isSubmitting = true
    defer { isSubmitting = false }
    do {
      let info = try await client.createSession(buildRequest())
      errorMessage = nil
      return info
    } catch {
      errorMessage = SessionListModel.describe(error)
      return nil
    }
  }

  func buildRequest() -> CreateSessionRequest {
    var sources: [SettingSource] = []
    if useUserSettings { sources.append(.user) }
    if useProjectSettings { sources.append(.project) }
    if useLocalSettings { sources.append(.local) }

    let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedResume = resume.trimmingCharacters(in: .whitespacesAndNewlines)
    let capabilities = self.capabilities

    return CreateSessionRequest(
      cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines),
      profile: profilesUnavailable ? nil : profileName,
      prompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt,
      permissionMode: permissionMode,
      // Picking bypass up front also pre-authorizes switching back to it later —
      // without this the mode can be set once and never re-enabled mid-session.
      allowDangerouslySkipPermissions: permissionMode == .bypassPermissions ? true : nil,
      // Fields the record forswears are omitted, not sent-and-refused: the
      // gateway 400s them, and the form should never build such a request.
      settingSources: capabilities.settingSources ? sources : nil,
      model: trimmedModel.isEmpty ? nil : trimmedModel,
      maxTurns: capabilities.budgets
        ? Int(maxTurns.trimmingCharacters(in: .whitespacesAndNewlines)) : nil,
      maxBudgetUsd: capabilities.budgets
        ? Double(maxBudgetUsd.trimmingCharacters(in: .whitespacesAndNewlines)) : nil,
      resume: capabilities.resume && !trimmedResume.isEmpty ? trimmedResume : nil,
      forkSession: engine == .claude && !trimmedResume.isEmpty && forkSession ? true : nil,
      reasoningEffort: !reasoningEffort.isEmpty && effortOptions.contains(reasoningEffort)
        ? reasoningEffort : nil,
      includePartialMessages: includePartialMessages)
  }
}
