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

  var body: some View {
    NavigationStack {
      HostFilesBrowser(scope: scope)
        .navigationTitle(Fmt.lastComponent(scope.cwd))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Done") { dismiss() }
          }
        }
    }
  }
}

/// The browser without a frame around it, in two navigation modes.
///
/// The phone's sheet wraps it in a `NavigationStack` and drills with
/// `NavigationLink`, so the stack *is* the path. The iPad's rail cannot: a
/// `NavigationLink` inside a `NavigationSplitView` column resolves against the
/// **split view**, so a sub-folder pushed itself over the whole detail pane
/// instead of staying in its 280pt column. `inline` mode is the fix — the rail
/// owns a plain `[String]` of directories and draws the top of it, which is
/// self-contained by construction rather than by hoping the nearest stack wins.
struct HostFilesBrowser: View {
  let scope: HostFileScope
  // Where a file row goes. Nil is the phone's sheet, which pushes the editor onto
  // its own stack; the iPad workspace passes a closure and opens a tab instead.
  var onOpenFile: ((String) -> Void)?
  var inline = false

  @State private var model: HostFilesModel?
  @State private var stack: [String] = []

  var body: some View {
    Group {
      if let model {
        content(model)
      } else {
        ProgressView()
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
      if inline {
        inlineBrowser(model)
      } else {
        HostDirectoryView(model: model, path: model.cwd, onOpenFile: onOpenFile)
      }
    }
  }

  private func inlineBrowser(_ model: HostFilesModel) -> some View {
    let current = stack.last ?? model.cwd
    return VStack(spacing: 0) {
      Breadcrumbs(
        root: model.cwd, stack: stack,
        onSelect: { depth in stack = Array(stack.prefix(depth)) })
      Divider()
      HostDirectoryView(
        model: model, path: current, onOpenFile: onOpenFile,
        onOpenDirectory: { stack.append($0) })
    }
  }
}

/// Where you are in the rail, and every way back out of it.
///
/// A breadcrumb rather than a back chevron: the rail is 280pt of a screen that
/// also holds a transcript, so climbing out of `packages/ui/src/components` one
/// tap at a time is the wrong trade. Every crumb is a full-height button, which
/// is also the answer to a chevron being a small target.
private struct Breadcrumbs: View {
  let root: String
  let stack: [String]
  let onSelect: (Int) -> Void

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        HStack(spacing: 2) {
          crumb(Fmt.lastComponent(root), depth: 0, last: stack.isEmpty)
          ForEach(Array(stack.enumerated()), id: \.offset) { index, path in
            Image(systemName: "chevron.right")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(.tertiary)
            crumb(Fmt.lastComponent(path), depth: index + 1, last: index == stack.count - 1)
          }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.hidden)
      // Left-aligned while it fits, and following the folder you just entered
      // when it does not — a trailing anchor pinned a two-crumb path to the
      // right edge, which read as the rail being misaligned.
      .onChange(of: stack.count) { _, _ in
        withAnimation { proxy.scrollTo(stack.count, anchor: .trailing) }
      }
    }
    .frame(height: 38)
    .background(.bar)
  }

  private func crumb(_ name: String, depth: Int, last: Bool) -> some View {
    Button { onSelect(depth) } label: {
      Text(name)
        .font(.subheadline.weight(last ? .semibold : .regular))
        .foregroundStyle(last ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
        .lineLimit(1)
        .padding(.horizontal, 6)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(last)
    .id(depth)
  }
}

/// One directory. Pushed per level, so the navigation stack *is* the path — and
/// since the stack starts at the cwd, there is nowhere above it to go.
private struct HostDirectoryView: View {
  let model: HostFilesModel
  let path: String
  var onOpenFile: ((String) -> Void)?
  // Set in the rail's inline mode, where there is no stack to push onto — and
  // also what says this view must not name a navigation title it does not own.
  var onOpenDirectory: ((String) -> Void)?

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
    .modifier(
      OptionalNavigationTitle(
        title: onOpenDirectory == nil ? Fmt.lastComponent(path) : nil))
    .refreshable { await model.loadDirectory(path, force: true) }
    // Keyed: inline, this view keeps its position and only its `path` changes,
    // so a bare `.task` loaded the root once and never the folder you entered.
    .task(id: path) { await model.loadDirectory(path) }
  }

  @ViewBuilder
  private func row(_ entry: HostDirEntry) -> some View {
    switch entry.type {
    case .dir:
      if let onOpenDirectory {
        Button { onOpenDirectory(entry.path) } label: { EntryRow(entry: entry) }
          .buttonStyle(.plain)
      } else {
        NavigationLink {
          HostDirectoryView(model: model, path: entry.path, onOpenFile: onOpenFile)
        } label: {
          EntryRow(entry: entry)
        }
      }
    case .file, .symlink:
      // A symlink is opened like a file: only the server knows whether it resolves
      // somewhere allowed, and it answers that by refusing the read.
      if let onOpenFile {
        Button { onOpenFile(entry.path) } label: { EntryRow(entry: entry) }
          .buttonStyle(.plain)
      } else {
        NavigationLink {
          HostFileView(model: model, path: entry.path)
        } label: {
          EntryRow(entry: entry)
        }
      }
    case .other:
      EntryRow(entry: entry).foregroundStyle(.secondary)
    }
  }
}

// Inline, this view is a *column* inside someone else's stack, so it must not
// name a title at all — applying one with an empty string overwrote the
// session's, which is what blanked the header when the rail was open.
private struct OptionalNavigationTitle: ViewModifier {
  let title: String?

  func body(content: Content) -> some View {
    if let title {
      content
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    } else {
      content
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
