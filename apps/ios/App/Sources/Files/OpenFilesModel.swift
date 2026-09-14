import WorkerDeckKit
import Foundation
import Observation

/// The tabs above the transcript in the iPad workspace — the Swift side of the
/// dashboard's `useOpenFiles`.
///
/// A thin owner rather than a reducer: `HostFileModel` already carries a file's
/// whole life (load, draft, dirty, save, the 409), so what is left is which
/// files are open and which one is showing. The tab is keyed on the path that
/// was asked for, never the canonical one the gateway answers with, which is
/// the same rule the web reducer states.
@MainActor
@Observable
final class OpenFilesModel {
  private(set) var files: [HostFileModel] = []
  private(set) var activePath: String?
  /// Whether the gateway was started with `--fs-write`. Asked here rather than
  /// read off the browser's model: the Save control belongs to the pane, and a
  /// pane whose editing gate depended on a rail having been opened first would
  /// offer a write the server refuses.
  private(set) var canWrite = false

  private let client: WorkerClient

  init(client: WorkerClient) {
    self.client = client
  }

  func loadCapability() async {
    canWrite = (try? await client.listHostRoots().canWrite) ?? false
  }

  var active: HostFileModel? {
    files.first { $0.path == activePath }
  }

  var hasUnsaved: Bool {
    files.contains { $0.isDirty }
  }

  func open(_ path: String) {
    activePath = path
    guard !files.contains(where: { $0.path == path }) else { return }
    let file = HostFileModel(client: client, path: path)
    files.append(file)
    Task { await file.load() }
  }

  func activate(_ path: String) {
    guard files.contains(where: { $0.path == path }) else { return }
    activePath = path
  }

  func close(_ path: String) {
    guard let index = files.firstIndex(where: { $0.path == path }) else { return }
    files.remove(at: index)
    guard activePath == path else { return }
    // The right-hand neighbour has slid into this index; a closed last tab has
    // nothing there.
    activePath = (files.indices.contains(index) ? files[index] : files.last)?.path
  }

  func closeAll() {
    files = []
    activePath = nil
  }
}
