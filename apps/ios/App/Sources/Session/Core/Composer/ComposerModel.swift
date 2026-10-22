import Foundation
import Observation
import UIKit
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The transport the composer's core object asks for: answers to the calls it names, and uploads of staged bytes.
struct CoreComposerServices: Sendable {
  var perform: (@Sendable (HttpCall) async -> HttpAnswer)?
  var upload: (@Sendable (HttpCall, String, Data) async -> HttpAnswer)?

  static func live(client: WorkerClient) -> Self {
    Self(
      perform: { call in await client.answer(call) },
      upload: { call, mediaType, data in await client.upload(call, mediaType: mediaType, data: data) })
  }
}

// The core `Composer` plus what only the app can do: wait, move bytes, keep thumbnails. Every rule is the core's.
@MainActor
@Observable
final class ComposerModel {
  let core: Composer
  private let services: CoreComposerServices
  private(set) var suggestions: [Suggestion] = []
  private(set) var chips: [AttachmentChip] = []
  private(set) var thumbnails: [UInt64: UIImage] = [:]
  private(set) var revision = 0
  var errorText: String?
  private var staged: [UInt64: PickedFile] = [:]
  private var search: Task<Void, Never>?

  init(core: Composer, services: CoreComposerServices) {
    self.core = core
    self.services = services
  }

  func view(draft: String, now: Date = Date()) -> ComposerView {
    _ = revision
    return core.view(draft: draft, nowMs: Int64(now.timeIntervalSince1970 * 1000))
  }

  func tokens(_ draft: String) -> [TokenSpan] { core.tokens(draft: draft) }

  func edit(_ draft: String, cursor: Int) {
    switch core.edit(draft: draft, cursor: UInt32(clamping: cursor)) {
    case .unchanged: return
    case .changed: readSuggestions()
    case .search(let generation, let delayMs, let call):
      readSuggestions()
      search?.cancel()
      search = Task { [weak self, core, services] in
        try? await Task.sleep(for: .milliseconds(Int(delayMs)))
        guard !Task.isCancelled, core.isCurrent(generation: generation), let perform = services.perform else { return }
        let answer = await perform(call)
        guard !Task.isCancelled, core.filesAnswered(generation: generation, answer: answer) else { return }
        self?.readSuggestions()
      }
    }
  }

  func accept(_ index: Int, draft: String, cursor: Int) -> DraftEdit? {
    defer { readSuggestions() }
    return core.accept(index: UInt32(index), draft: draft, cursor: UInt32(clamping: cursor))
  }

  func dismissSuggestions() {
    search?.cancel()
    if core.dismissSuggestions() { readSuggestions() }
  }

  func leadingTrigger(_ character: String) -> Bool {
    let switched = core.leadingTrigger(character: character)
    if switched { changed() }
    return switched
  }

  func exitShell(_ draft: String) -> DraftEdit {
    defer { changed() }
    return core.exitShell(draft: draft)
  }

  func send(_ draft: String, background: Bool = false) -> Outgoing? {
    guard let outgoing = core.send(draft: draft, background: background) else { return nil }
    search?.cancel()
    if case .message = outgoing {
      staged = [:]
      thumbnails = [:]
    }
    readSuggestions()
    readChips()
    return outgoing
  }

  // The `#` list: polled slowly, a name is not a reading and only has to be right when the list opens.
  func pollPeers() async {
    guard let perform = services.perform else { return }
    while !Task.isCancelled {
      let answer = await perform(listSessionsCall())
      if answer.status == 200, core.setPeers(body: answer.body) { changed() }
      try? await Task.sleep(for: .seconds(20))
    }
  }

  // MARK: - Attachments

  func refusal(mediaType: String) -> String? { core.refusal(mediaType: mediaType) }

  func announce(_ message: String) { errorText = message }

  func add(_ picked: PickedFile) {
    let upload = core.addAttachment(name: picked.name, mediaType: picked.mediaType)
    readChips()
    guard let upload else {
      errorText = core.takeError()
      return
    }
    staged[upload.id] = picked
    thumbnails[upload.id] = picked.thumbnail
    start(upload, picked)
  }

  func retry(_ id: UInt64) {
    guard let picked = staged[id], let upload = core.retryAttachment(id: id) else { return }
    readChips()
    start(upload, picked)
  }

  func remove(_ id: UInt64) {
    core.removeAttachment(id: id)
    staged[id] = nil
    thumbnails[id] = nil
    readChips()
  }

  // The session moved on to its next conversation: the files go up again there, under the ids the core hands out.
  func reupload(_ moves: [Reupload]) {
    for move in moves {
      let picked = staged.removeValue(forKey: move.replaces)
      thumbnails[move.upload.id] = thumbnails.removeValue(forKey: move.replaces)
      guard let picked else {
        core.removeAttachment(id: move.upload.id)
        continue
      }
      staged[move.upload.id] = picked
      start(move.upload, picked)
    }
    readChips()
  }

  private func start(_ upload: Upload, _ picked: PickedFile) {
    let send = services.upload
    Task { [weak self, core] in
      let answer =
        await send?(upload.call, picked.mediaType, picked.data) ?? HttpAnswer(status: 0, contentType: nil, body: "")
      guard core.uploaded(id: upload.id, answer: answer), let self else { return }
      if let error = core.takeError() { errorText = error }
      readChips()
    }
  }

  private func readSuggestions() {
    suggestions = core.suggestions()
    changed()
  }

  private func readChips() {
    chips = core.attachments()
    changed()
  }

  private func changed() { revision &+= 1 }
}
