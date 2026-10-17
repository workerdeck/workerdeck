import WorkerDeckCore
import WorkerDeckKit
import Foundation
import Observation

// The create form over the core's `CreateForm`, which owns the field rules (profile -> engine -> modes, models,
// efforts) and builds the request. This keeps the fields observable and moves the bytes.
@MainActor
@Observable
final class CreateSessionModel {
  private var stored: CreateFormFields
  private(set) var state: CreateFormState
  private(set) var isLoadingProfiles = false
  private(set) var isSubmitting = false
  private(set) var errorMessage: String?

  private let form: CreateForm
  private let client: WorkerClient

  init(form: CreateForm, client: WorkerClient) {
    self.form = form
    self.client = client
    stored = form.fields()
    state = form.state()
  }

  // Every edit goes through the core, which answers the fields as it keeps them (a profile change adopts defaults).
  var fields: CreateFormFields {
    get { stored }
    set {
      stored = form.update(fields: newValue)
      state = form.state()
    }
  }

  var sharing: Sharing {
    get { state.sharing }
    set { fields.sharing = newValue }
  }

  // The folder picker browses the same gateway's host filesystem.
  var fileClient: WorkerClient { client }

  var canSubmit: Bool { state.canSubmit && !isSubmitting }

  var modelPicker: ModelPicker { form.modelPicker() }
  var modePicker: ModePicker { form.modePicker() }

  func loadProfiles() async {
    guard state.needsProfiles else { return }
    isLoadingProfiles = true
    defer { isLoadingProfiles = false }
    do {
      let body = try await client.perform(listProfilesCall())
      _ = form.setProfiles(body: String(decoding: body, as: UTF8.self))
    } catch let error as WorkerClientError where error.statusCode == 404 {
      form.setProfilesUnavailable()
    } catch {
      errorMessage = SessionListModel.describe(error)
    }
    reload()
  }

  func loadResumeCandidates() async throws -> [SdkSession] {
    let body = String(decoding: try await client.perform(form.resumeCandidatesCall()), as: UTF8.self)
    guard let stored = sdkSessions(body: body, nowMs: Date().timeIntervalSince1970 * 1000) else {
      throw WorkerClientError(message: "The gateway sent stored sessions this app cannot read")
    }
    return stored
  }

  func adoptStoredSession(_ summary: SdkSession) {
    form.adoptStoredSession(
      sessionId: summary.sessionId, cwd: summary.cwd, customTitle: summary.customTitle, summary: summary.summary)
    reload()
  }

  func submit() async -> Created? {
    await creating(createdSession(body:))
  }

  func submitAgent() async -> Created? {
    await creating(createdAgent(body:))
  }

  private func creating(_ read: (String) -> Created?) async -> Created? {
    isSubmitting = true
    defer { isSubmitting = false }
    do {
      let body = String(decoding: try await client.perform(form.call()), as: UTF8.self)
      guard let created = read(body) else {
        throw WorkerClientError(message: "The gateway answered in a shape this app cannot read")
      }
      errorMessage = nil
      return created
    } catch {
      errorMessage = SessionListModel.describe(error)
      return nil
    }
  }

  private func reload() {
    stored = form.fields()
    state = form.state()
  }
}
