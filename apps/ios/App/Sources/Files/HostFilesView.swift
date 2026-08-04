import WorkerDeckKit
import SwiftUI

/// The session's working directory, browsed one level at a time.
///
/// Scoped to the session on purpose, and rooted at its `cwd`: there is no roots
/// list and no way up, because the useful question on a phone is "what is in this
/// project", not "what does this gateway expose". The server's roots still decide
/// what is *allowed* — this only decides what is offered.
///
/// Deliberately not the same thing as `SessionFilesSection`, which lists one
/// session's in-memory deliverables. This reads the operator's real disk,
/// authorized by the auth key alone.
struct HostFilesView: View {
  let scope: HostFileScope

  @Environment(\.dismiss) private var dismiss
  @State private var model: HostFilesModel?

  var body: some View {
    NavigationStack {
      Group {
        if let model {
          content(model)
        } else {
          ProgressView()
        }
      }
      .navigationTitle(Fmt.lastComponent(scope.cwd))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
    .task {
      let live = model ?? HostFilesModel(scope: scope)
      model = live
      await live.load()
    }
  }

  @ViewBuilder
  private func content(_ model: HostFilesModel) -> some View {
    switch model.availability {
    case .loading:
      ProgressView()
    case .unavailable:
      ContentUnavailableView {
        Label("No file access", systemImage: "folder.badge.questionmark")
      } description: {
        Text(
          "This server exposes no directories. Start it with --fs-root <path> "
            + "(add --fs-write to allow editing) and this session's folder shows up here.")
      }
    case .outsideRoots:
      ContentUnavailableView {
        Label("Outside the server's roots", systemImage: "folder.badge.minus")
      } description: {
        Text(
          "\(scope.cwd) isn't under any --fs-root this server was started with, "
            + "so it won't serve files from it.")
      }
    case .failed(let message):
      ContentUnavailableView {
        Label("Couldn't reach the server", systemImage: "exclamationmark.triangle")
      } description: {
        Text(message)
      } actions: {
        Button("Try again") { Task { await model.load() } }
      }
    case .ready:
      HostDirectoryView(model: model, path: model.cwd)
    }
  }
}

/// One directory. Pushed per level, so the navigation stack *is* the path — and
/// since the stack starts at the cwd, there is nowhere above it to go.
private struct HostDirectoryView: View {
  let model: HostFilesModel
  let path: String

  var body: some View {
    List {
      if let listing = model.listing(for: path) {
        if listing.entries.isEmpty {
          ContentUnavailableView("Empty directory", systemImage: "folder")
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
        ForEach(listing.entries) { entry in
          row(entry)
        }
        if listing.truncated == true {
          Text("Listing truncated — this directory has more entries than the server returns.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      } else if model.isLoading(path) {
        HStack { Spacer(); ProgressView(); Spacer() }
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
    }
    .listStyle(.plain)
    .navigationTitle(Fmt.lastComponent(path))
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await model.loadDirectory(path, force: true) }
    .task { await model.loadDirectory(path) }
  }

  @ViewBuilder
  private func row(_ entry: HostDirEntry) -> some View {
    switch entry.type {
    case .dir:
      NavigationLink {
        HostDirectoryView(model: model, path: entry.path)
      } label: {
        EntryRow(entry: entry)
      }
    case .file, .symlink:
      // A symlink is opened like a file: only the server knows whether it resolves
      // somewhere allowed, and it answers that by refusing the read.
      NavigationLink {
        HostFileView(model: model, path: entry.path)
      } label: {
        EntryRow(entry: entry)
      }
    case .other:
      EntryRow(entry: entry).foregroundStyle(.secondary)
    }
  }
}

private struct EntryRow: View {
  let entry: HostDirEntry

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(entry.type == .dir ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        .frame(width: 20)
      Text(entry.name)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 8)
      if let bytes = entry.bytes {
        Text(Fmt.bytes(bytes))
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
    }
  }

  private var icon: String {
    switch entry.type {
    case .dir: "folder.fill"
    case .file: "doc"
    case .symlink: "arrow.turn.up.right"
    case .other: "questionmark.square.dashed"
    }
  }
}
