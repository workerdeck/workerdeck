import WorkerDeckKit
import Foundation
import Observation

/// One session's window onto the host filesystem: the client, plus the working
/// directory everything is scoped to.
///
/// The server's `hostFiles.roots` remain the security boundary — this is a UI
/// scope, not an enforcement one. What it buys is the right question: on a phone
/// you want *this session's* project, not a root picker, and a session whose cwd
/// the server does not expose should say so instead of offering somewhere else.
struct HostFileScope: Sendable {
  let client: WorkerClient
  let cwd: String
}

/// Browsing state for one session's working directory.
///
/// The whole surface is optional server-side, and a 404 is the *normal* answer
/// from a gateway started without `--fs-root` — so availability is a first-class
/// state rather than an error banner: the browser explains how to turn it on
/// instead of looking broken.
///
/// Listings are cached per canonical path so walking back up is instant; pull to
/// refresh re-fetches the level on screen, which is also how you notice the agent
/// changed something.
@MainActor
@Observable
final class HostFilesModel {
  enum Availability: Equatable {
    case loading
    /// The server exposes no host files at all.
    case unavailable
    /// The server exposes files, but not this session's working directory.
    case outsideRoots
    case ready(canWrite: Bool)
    /// Reaching the server failed — distinct from the two above, which are answers.
    case failed(String)
  }

  let scope: HostFileScope
  private(set) var availability: Availability = .loading
  /// Listings by canonical directory path.
  private(set) var listings: [String: ListHostDirResponse] = [:]
  /// Paths with a fetch in flight, so a row can spin without a global overlay.
  private(set) var loading: Set<String> = []
  var errorMessage: String?

  init(scope: HostFileScope) {
    self.scope = scope
  }

  var client: WorkerClient { scope.client }
  var cwd: String { scope.cwd }

  var canWrite: Bool {
    if case .ready(let canWrite) = availability { return canWrite }
    return false
  }

  /// Two questions in one pass: does this gateway serve files at all (`/fs/roots`),
  /// and is *this* session's directory one it will serve (the first listing)? They
  /// have different answers and deserve different screens — "no file access" is a
  /// flag the operator can add, "outside the roots" is a path they'd have to widen.
  func load() async {
    if case .ready = availability { return }
    availability = .loading
    let canWrite: Bool
    do {
      canWrite = try await client.listHostRoots().canWrite
    } catch let error as WorkerClientError {
      availability = error.statusCode == 404 ? .unavailable : .failed(error.message)
      return
    } catch {
      availability = .failed(error.localizedDescription)
      return
    }
    do {
      let listing = try await client.listHostDir(path: cwd)
      listings[listing.path] = listing
      if listing.path != cwd { listings[cwd] = listing }
      availability = .ready(canWrite: canWrite)
    } catch let error as WorkerClientError {
      // Every filesystem refusal is a uniform 404 by design (it must not become an
      // existence oracle), so this covers both "not under a root" and "gone".
      availability = error.statusCode == 404 ? .outsideRoots : .failed(error.message)
    } catch {
      availability = .failed(error.localizedDescription)
    }
  }

  /// Fetch a directory, unless it is already cached. `force` re-fetches — the agent
  /// is editing this tree, so a cached listing goes stale on its own.
  func loadDirectory(_ path: String, force: Bool = false) async {
    if !force, listings[path] != nil { return }
    guard !loading.contains(path) else { return }
    loading.insert(path)
    defer { loading.remove(path) }
    do {
      let response = try await client.listHostDir(path: path)
      // Keyed by the *canonical* path the server answered with, not the one asked
      // for: they differ whenever the request crossed a symlink, and caching under
      // the request would make the same directory appear twice.
      listings[response.path] = response
      if response.path != path { listings[path] = response }
    } catch let error as WorkerClientError {
      errorMessage = error.message
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func listing(for path: String) -> ListHostDirResponse? { listings[path] }
  func isLoading(_ path: String) -> Bool { loading.contains(path) }
}

/// A file open in the viewer/editor.
///
/// Holds both what was read and what is being edited, because saving needs the
/// hash of the former: every write on this API is conditional, so an edit that
/// loses track of its base can only be rebased, never forced.
@MainActor
@Observable
final class HostFileModel {
  enum Content: Equatable {
    case loading
    /// Editable text plus the hash the edit is based on.
    case text(original: String, hash: String)
    /// A file the editor declines to open rather than corrupt on save.
    case binary(bytes: Int)
    case failed(String)
  }

  let path: String
  private(set) var content: Content = .loading
  private(set) var modifiedAt: Double?
  /// Live buffer, diverging from `original` as the user types.
  var draft: String = ""
  private(set) var saving = false
  var errorMessage: String?
  /// Set when the server refused the write because the file changed underneath —
  /// worth its own message, since the fix is to reload rather than to retry.
  private(set) var conflict = false

  private let client: WorkerClient

  init(client: WorkerClient, path: String) {
    self.client = client
    self.path = path
  }

  var isDirty: Bool {
    guard case .text(let original, _) = content else { return false }
    return draft != original
  }

  func load() async {
    content = .loading
    conflict = false
    do {
      let response = try await client.readHostFile(path: path)
      modifiedAt = response.modifiedAt
      if let text = response.text {
        content = .text(original: text, hash: response.hash)
        draft = text
      } else {
        content = .binary(bytes: response.bytes)
      }
    } catch let error as WorkerClientError {
      content = .failed(error.message)
    } catch {
      content = .failed(error.localizedDescription)
    }
  }

  func save() async {
    guard case .text(_, let hash) = content, !saving else { return }
    saving = true
    defer { saving = false }
    do {
      let response = try await client.writeHostFile(
        WriteHostFileRequest(path: path, text: draft, expectedHash: hash))
      // The write's own hash becomes the base for the next one, so a second save
      // without an intervening read still satisfies the precondition.
      content = .text(original: draft, hash: response.hash)
      modifiedAt = response.modifiedAt
      conflict = false
    } catch let error as WorkerClientError {
      conflict = error.statusCode == 409
      errorMessage = error.message
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
