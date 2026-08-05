import WorkerDeckKit
import SwiftUI

/// Pick a working directory off the host, for the New Session form.
///
/// The sibling of `HostFilesView`, and deliberately not the same screen. That one
/// is rooted at a session's cwd and opens files; this one starts at the server's
/// roots — there is no cwd yet, that is what is being chosen — shows directories
/// only, and every level can be selected as well as entered.
///
/// The roots it offers are the server's *read* roots, which is the right set:
/// they are what `--cwd-root`/`--fs-root` allow, so a folder picked here is one
/// the gateway will also agree to start a session in.
struct FolderPickerView: View {
  let client: WorkerClient
  let onSelect: (String) -> Void
  /// Pre-built state, for `UIPreviewHarness`. Nil in the app, where the model is
  /// created on appear and loads itself.
  var seeded: FolderPickerModel?

  @Environment(\.dismiss) private var dismiss
  @State private var model: FolderPickerModel?

  var body: some View {
    NavigationStack {
      Group {
        if let model {
          content(model)
        } else {
          ProgressView()
        }
      }
      .navigationTitle("Choose folder")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .task {
      let live = model ?? seeded ?? FolderPickerModel(client: client)
      model = live
      await live.load()
    }
  }

  @ViewBuilder
  private func content(_ model: FolderPickerModel) -> some View {
    switch model.availability {
    case .loading:
      ProgressView()
    case .unavailable:
      ContentUnavailableView {
        Label("No file access", systemImage: "folder.badge.questionmark")
      } description: {
        Text(
          "This server exposes no directories to browse. Start it with --fs-root <path> "
            + "(or --cwd-root) and folders show up here — you can still type a path.")
      }
    case .failed(let message):
      ContentUnavailableView {
        Label("Couldn't reach the server", systemImage: "exclamationmark.triangle")
      } description: {
        Text(message)
      } actions: {
        Button("Try again") { Task { await model.load() } }
      }
    case .ready(let roots):
      // One root is not a choice — start inside it, so the first screen is
      // already the list you came to look at.
      if roots.count == 1, let root = roots.first {
        FolderLevelView(model: model, path: root.path, select: select)
      } else {
        List(roots) { root in
          NavigationLink {
            FolderLevelView(model: model, path: root.path, select: select)
          } label: {
            FolderRow(name: root.name, subtitle: root.path, isSymlink: false)
          }
        }
        .listStyle(.plain)
      }
    }
  }

  private func select(_ path: String) {
    onSelect(path)
    dismiss()
  }
}

/// One directory level. Entering is a row; choosing is the toolbar button, so
/// every folder on the way down can be the answer.
private struct FolderLevelView: View {
  let model: FolderPickerModel
  let path: String
  let select: (String) -> Void

  var body: some View {
    List {
      if let entries = model.listing(for: path) {
        if entries.isEmpty {
          ContentUnavailableView("No subfolders", systemImage: "folder")
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
        ForEach(entries) { entry in
          NavigationLink {
            FolderLevelView(model: model, path: entry.path, select: select)
          } label: {
            FolderRow(name: entry.name, subtitle: nil, isSymlink: entry.type == .symlink)
          }
        }
      } else if model.isLoading(path) {
        HStack { Spacer(); ProgressView(); Spacer() }
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if let message = model.errorMessage {
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .listStyle(.plain)
    .navigationTitle(Fmt.lastComponent(path))
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom) {
      Button {
        select(path)
      } label: {
        Text("Use \(Fmt.lastComponent(path))")
          .font(.body.weight(.medium))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
      }
      .buttonStyle(.borderedProminent)
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
      .background(.bar)
    }
    .task { await model.loadDirectory(path) }
  }
}

private struct FolderRow: View {
  let name: String
  let subtitle: String?
  let isSymlink: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: isSymlink ? "arrow.turn.up.right" : "folder.fill")
        .foregroundStyle(.tint)
        .frame(width: 20)
      VStack(alignment: .leading, spacing: 1) {
        Text(name)
          .lineLimit(1)
          .truncationMode(.middle)
        if let subtitle {
          Text(subtitle)
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
        }
      }
    }
  }
}
