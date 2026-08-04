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

  var selectedProfile: ProfileInfo? {
    profiles.first { $0.name == profileName }
  }

  /// Engine the session will actually run on. Absent profile info reads as claude,
  /// matching `ProfileInfo.resolvedEngine`.
  var engine: ProfileEngine {
    selectedProfile?.resolvedEngine ?? .claude
  }

  /// Only the modes this engine understands — the provider engine implements a
  /// subset, and offering the rest would just produce a server-side rejection.
  var availableModes: [PermissionMode] {
    PermissionMode.allCases.filter { supportsPermissionMode(engine: engine, mode: $0) }
  }

  /// Model ids the chosen profile advertises. Empty → free-text field (the Claude
  /// engine only reports its options once a session is live, via `capabilities`).
  var modelOptions: [String] {
    selectedProfile?.provider?.models ?? []
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

  /// Adopt the profile's declared defaults, and snap the permission mode back into
  /// range if the new engine doesn't support the current one.
  func applyProfileDefaults() {
    guard let profile = selectedProfile else { return }
    if let defaultModel = profile.defaults?.model, model.isEmpty { model = defaultModel }
    if let defaultMode = profile.defaults?.permissionMode,
      supportsPermissionMode(engine: profile.resolvedEngine, mode: defaultMode)
    {
      permissionMode = defaultMode
    } else if !supportsPermissionMode(engine: profile.resolvedEngine, mode: permissionMode) {
      permissionMode = .default
    }
    if !modelOptions.isEmpty, !modelOptions.contains(model) {
      model = profile.provider?.model ?? modelOptions[0]
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

    return CreateSessionRequest(
      cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines),
      profile: profilesUnavailable ? nil : profileName,
      prompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt,
      permissionMode: permissionMode,
      // Picking bypass up front also pre-authorizes switching back to it later —
      // without this the mode can be set once and never re-enabled mid-session.
      allowDangerouslySkipPermissions: permissionMode == .bypassPermissions ? true : nil,
      settingSources: sources,
      model: trimmedModel.isEmpty ? nil : trimmedModel,
      maxTurns: Int(maxTurns.trimmingCharacters(in: .whitespacesAndNewlines)),
      maxBudgetUsd: Double(maxBudgetUsd.trimmingCharacters(in: .whitespacesAndNewlines)),
      resume: trimmedResume.isEmpty ? nil : trimmedResume,
      forkSession: trimmedResume.isEmpty ? nil : (forkSession ? true : nil),
      includePartialMessages: includePartialMessages)
  }
}
