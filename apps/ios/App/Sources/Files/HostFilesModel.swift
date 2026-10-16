import Foundation
import Observation
import WorkerDeckCore
import WorkerDeckKit

// How the file screens reach a gateway: a call the core named, its answer back whole for the core to read.
typealias HostTransport = @Sendable (HttpCall) async -> HttpAnswer

// One session's window onto the host filesystem: the transport, plus the working directory it is rooted at. The
// gateway's roots stay the security boundary; this is the UI's scope.
struct HostFileScope: Sendable {
  let transport: HostTransport
  let cwd: String

  init(client: WorkerClient, cwd: String) {
    self.init(transport: { await client.answer($0) }, cwd: cwd)
  }

  init(transport: @escaping HostTransport, cwd: String) {
    self.transport = transport
    self.cwd = cwd
  }
}

// The browser over the core's `HostFiles`, which owns availability, the listing cache and what is in flight. This
// moves the bytes and republishes the core's state after each answer.
@MainActor
@Observable
final class HostFilesModel {
  let scope: HostFileScope
  private(set) var availability: HostFilesAvailability = .loading
  private(set) var errorMessage: String?
  private var revision = 0

  private let files: HostFiles

  init(scope: HostFileScope) {
    self.scope = scope
    files = HostFiles.session(cwd: scope.cwd)
  }

  var transport: HostTransport { scope.transport }
  var cwd: String { scope.cwd }
  var canWrite: Bool {
    if case .ready(let canWrite) = availability { canWrite } else { false }
  }

  func load() async {
    guard let call = files.loadCall() else { return }
    sync()
    if let next = files.rootsAnswered(answer: await transport(call)) {
      files.cwdAnswered(answer: await transport(next))
    }
    sync()
  }

  func loadDirectory(_ path: String, force: Bool = false) async {
    guard let call = files.listCall(path: path, force: force) else { return }
    sync()
    files.listed(path: path, answer: await transport(call))
    sync()
  }

  func dismissError() {
    files.clearError()
    sync()
  }

  func listing(for path: String) -> HostListing? {
    _ = revision
    return files.listing(path: path)
  }

  func isLoading(_ path: String) -> Bool {
    _ = revision
    return files.isLoading(path: path)
  }

  private func sync() {
    availability = files.availability()
    errorMessage = files.error()
    revision &+= 1
  }
}

// One host file in the viewer/editor over the core's `HostFileEditor`, which holds the draft, the base hash every
// save is conditional on, and what a 409 means.
@MainActor
@Observable
final class HostFileModel {
  let path: String
  private(set) var state: HostFileState
  private let editor: HostFileEditor
  private let transport: HostTransport

  init(transport: @escaping HostTransport, path: String) {
    self.transport = transport
    self.path = path
    editor = HostFileEditor(path: path)
    state = editor.state()
  }

  var draft: String {
    get { editor.draft() }
    set {
      editor.setDraft(draft: newValue)
      state = editor.state()
    }
  }

  var errorMessage: String? {
    get { state.error }
    set {
      if newValue == nil { editor.clearError() }
      state = editor.state()
    }
  }

  func load() async {
    let call = editor.loadCall()
    state = editor.state()
    editor.readAnswered(answer: await transport(call))
    state = editor.state()
  }

  func save() async {
    guard let call = editor.saveCall() else { return }
    state = editor.state()
    editor.saveAnswered(answer: await transport(call))
    state = editor.state()
  }
}

extension HostEntry: @retroactive Identifiable {
  public var id: String { path }
}

extension HostRoot: @retroactive Identifiable {
  public var id: String { path }
}
