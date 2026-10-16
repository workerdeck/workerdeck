import Foundation
import Observation
import WorkerDeckCore
import WorkerDeckKit

// The folder picker over the core's `HostFiles.folders`: the gateway's roots, then directories only (symlinks kept,
// since entering one either lists or is refused), cached by the path asked for and the canonical one.
@MainActor
@Observable
final class FolderPickerModel {
  private(set) var availability: HostFilesAvailability = .loading
  private(set) var roots: [HostRoot] = []
  private(set) var errorMessage: String?
  private var revision = 0

  private let files = HostFiles.folders()
  private let transport: HostTransport

  init(transport: @escaping HostTransport) {
    self.transport = transport
  }

  func load() async {
    guard let call = files.loadCall() else { return }
    sync()
    _ = files.rootsAnswered(answer: await transport(call))
    sync()
  }

  func loadDirectory(_ path: String, force: Bool = false) async {
    guard let call = files.listCall(path: path, force: force) else { return }
    sync()
    files.listed(path: path, answer: await transport(call))
    sync()
  }

  func listing(for path: String) -> [HostEntry]? {
    _ = revision
    return files.listing(path: path)?.entries
  }

  func isLoading(_ path: String) -> Bool {
    _ = revision
    return files.isLoading(path: path)
  }

  private func sync() {
    availability = files.availability()
    roots = files.roots()
    errorMessage = files.error()
    revision &+= 1
  }
}
