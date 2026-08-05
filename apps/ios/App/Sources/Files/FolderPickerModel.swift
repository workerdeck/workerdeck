import WorkerDeckKit
import Foundation
import Observation

/// Browsing state for the folder picker: the server's roots, plus a cache of the
/// directories walked into.
///
/// Directories only — a working directory is what is being chosen, so files are
/// filtered out here rather than in the view. Symlinks are kept: the server
/// reports them without resolving, and one pointing at a project directory is a
/// perfectly good answer; entering it either lists or 404s, which is the same
/// verdict the browser gets.
///
/// Separate from `HostFilesModel` on purpose: that one is rooted at a session's
/// cwd and never shows the roots list, which is exactly the screen this needs.
@MainActor
@Observable
final class FolderPickerModel {
  enum Availability: Equatable {
    case loading
    /// The server exposes no host files at all (`/fs/roots` 404s).
    case unavailable
    case ready([HostFileRoot])
    case failed(String)
  }

  private(set) var availability: Availability = .loading
  /// Directory entries by canonical path, already filtered to folders.
  private(set) var listings: [String: [HostDirEntry]] = [:]
  private(set) var loading: Set<String> = []
  var errorMessage: String?

  private let client: WorkerClient

  init(client: WorkerClient) {
    self.client = client
  }

  /// Canned state for `UIPreviewHarness`. Both fetches short-circuit on state
  /// that is already present, so a model built this way never reaches its client
  /// — which is why the preview can hand it one pointed nowhere.
  init(client: WorkerClient, roots: [HostFileRoot], listings: [String: [HostDirEntry]]) {
    self.client = client
    availability = .ready(roots)
    self.listings = listings
  }

  func load() async {
    if case .ready = availability { return }
    availability = .loading
    do {
      let response = try await client.listHostRoots()
      availability = .ready(response.roots)
    } catch let error as WorkerClientError {
      // A 404 is the normal answer from a gateway started without roots, not a
      // failure — the form still accepts a typed path.
      availability = error.statusCode == 404 ? .unavailable : .failed(error.message)
    } catch {
      availability = .failed(error.localizedDescription)
    }
  }

  func loadDirectory(_ path: String, force: Bool = false) async {
    if !force, listings[path] != nil { return }
    guard !loading.contains(path) else { return }
    loading.insert(path)
    defer { loading.remove(path) }
    do {
      let response = try await client.listHostDir(path: path)
      let folders = response.entries.filter { $0.type == .dir || $0.type == .symlink }
      // Keyed by the canonical path the server answered with as well as the one
      // asked for: they differ across a symlink, and the view asks by the latter.
      listings[response.path] = folders
      if response.path != path { listings[path] = folders }
      errorMessage = nil
    } catch let error as WorkerClientError {
      errorMessage = error.message
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func listing(for path: String) -> [HostDirEntry]? { listings[path] }
  func isLoading(_ path: String) -> Bool { loading.contains(path) }
}
