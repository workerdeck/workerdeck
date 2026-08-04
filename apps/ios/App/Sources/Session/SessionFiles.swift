import WorkerDeckKit
import SwiftUI
import UIKit

/// The two operations the UI needs against a session's file store, closed over
/// the client and session id.
struct SessionFileAccess: Sendable {
  var list: @Sendable () async throws -> [SessionFileInfo]
  var download: @Sendable (String) async throws -> URL

  /// Materialize downloaded bytes as a real file so the share sheet can offer
  /// "Save to Files", AirDrop and Quick Look. A fresh directory per download
  /// keeps the original filename (which is what the user sees) while making
  /// collisions between same-named files from different paths impossible.
  static func writeTemporary(_ data: Data, named name: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("session-files", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent(name.isEmpty ? "file" : name)
    try data.write(to: url, options: .atomic)
    return url
  }
}

/// Download state plus the share-sheet presentation it feeds.
///
/// One per *presentation context*, not one per session: a share sheet raised
/// from `SessionView` while the details sheet is open would have nowhere to
/// appear, so the details sheet owns its own. They share only the access struct.
@MainActor
@Observable
final class FileDownloader {
  var access: SessionFileAccess?
  /// Path currently downloading — drives the row's spinner.
  private(set) var inFlight: String?
  var shared: SharedFile?
  var errorText: String?

  func download(_ path: String) {
    guard let access, inFlight == nil else { return }
    inFlight = path
    Task {
      defer { inFlight = nil }
      do {
        shared = SharedFile(url: try await access.download(path))
      } catch {
        errorText = (error as? WorkerClientError)?.message ?? error.localizedDescription
      }
    }
  }
}

/// Reaches the `file_delivered` card, which sits several layers down inside the
/// transcript — threading a downloader through every row type to reach one card
/// is worse than one environment value. Absent outside a live session, and the
/// card then renders inert rather than offering a download it cannot perform.
private struct FileDownloaderKey: EnvironmentKey {
  static let defaultValue: FileDownloader? = nil
}

extension EnvironmentValues {
  var fileDownloader: FileDownloader? {
    get { self[FileDownloaderKey.self] }
    set { self[FileDownloaderKey.self] = newValue }
  }
}

/// A downloaded file on its way to the share sheet.
struct SharedFile: Identifiable {
  let url: URL
  var id: URL { url }
}

/// `UIActivityViewController`, which is what "download this" should end in on
/// iOS: preview, save to Files, send onward. SwiftUI's `ShareLink` needs its item
/// up front, and here the item only exists after the download.
struct ActivityView: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

extension View {
  /// Attach at the top of a presentation context, never on a transcript row —
  /// a sheet anchored to a lazily-recycled row goes away with the row.
  func fileDownloadPresentation(_ downloader: FileDownloader) -> some View {
    modifier(FileDownloadPresentation(downloader: downloader))
  }
}

private struct FileDownloadPresentation: ViewModifier {
  @Bindable var downloader: FileDownloader

  func body(content: Content) -> some View {
    content
      .sheet(item: $downloader.shared) { file in
        ActivityView(url: file.url)
      }
      .alert(
        "Download failed",
        isPresented: Binding(
          get: { downloader.errorText != nil },
          set: { if !$0 { downloader.errorText = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(downloader.errorText ?? "")
      }
  }
}

/// The session's file store, as a list. Only the provider engine has one —
/// Claude-engine sessions write to real disk and the endpoint 404s, so an
/// unavailable or empty store renders as nothing rather than as an error.
struct SessionFilesSection: View {
  /// Taken directly rather than off the downloader: a child `.task` can run
  /// before its parent's, so the downloader's copy may not be set yet.
  let access: SessionFileAccess?
  let downloader: FileDownloader

  @State private var files: [SessionFileInfo] = []

  var body: some View {
    Group {
      if !files.isEmpty {
        Section("Files") {
          ForEach(files) { file in
            Button {
              downloader.download(file.path)
            } label: {
              HStack(spacing: 10) {
                Image(systemName: "doc")
                  .foregroundStyle(.secondary)
                Text(file.path)
                  .font(.caption.monospaced())
                  .lineLimit(1)
                  .truncationMode(.middle)
                Spacer(minLength: 8)
                if downloader.inFlight == file.path {
                  ProgressView().controlSize(.mini)
                } else {
                  Text(Fmt.bytes(file.bytes))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                }
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .task {
      guard let access else { return }
      files = (try? await access.list()) ?? []
    }
  }
}
