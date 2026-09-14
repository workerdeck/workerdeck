import WorkerDeckKit
import SwiftUI

/// The open file, above the transcript, with a grab bar splitting the column.
///
/// The tabs are **not** here: they live in the navigation bar (`EditorTabsBar`,
/// hoisted into `.principal`) so the workspace has one header rather than three
/// stacked strips. What is left is the file and the split.
struct EditorPane: View {
  static let minHeight: CGFloat = 120
  static let minTranscriptHeight: CGFloat = 220
  static let defaultHeight: CGFloat = 360

  let files: OpenFilesModel
  let canWrite: Bool
  /// The column's own height, so the split can be clamped against the transcript's
  /// floor rather than against a guess.
  let available: CGFloat
  @Binding var height: CGFloat

  @State private var dragBase: CGFloat?

  var body: some View {
    VStack(spacing: 0) {
      Group {
        if let file = files.active {
          EditorFileView(file: file, canWrite: canWrite)
            .id(file.path)
        } else {
          Color.clear
        }
      }
      .frame(height: clamped)
      grabBar
    }
  }

  private var clamped: CGFloat {
    let ceiling = max(Self.minHeight, available - Self.minTranscriptHeight)
    return min(max(height, Self.minHeight), ceiling)
  }

  private var grabBar: some View {
    ZStack {
      Rectangle().fill(.bar)
      Capsule()
        .fill(.tertiary)
        .frame(width: 36, height: 4)
    }
    .frame(height: 14)
    .contentShape(Rectangle())
    .gesture(
      DragGesture(minimumDistance: 1)
        .onChanged { value in
          let base = dragBase ?? clamped
          dragBase = base
          height = base + value.translation.height
        }
        .onEnded { _ in
          height = clamped
          dragBase = nil
        })
    .accessibilityLabel("Resize the open file")
  }
}

/// The workspace's whole header line: the Files toggle, the project, then a
/// badge per open file.
///
/// **All of it is one `.principal` item**, including the Files button. Split
/// across `.topBarLeading` and `.principal` the bar left a gap between the two —
/// the principal region begins where the system decides the leading one ends —
/// and the project name is supposed to start straight after the button.
/// Claiming the full width and aligning leading is what puts it there.
struct EditorTabsBar: View {
  let project: String
  let files: OpenFilesModel
  let railShown: Bool
  let onToggleRail: () -> Void
  let onClose: (HostFileModel) -> Void

  var body: some View {
    HStack(spacing: 8) {
      Button(action: onToggleRail) {
        Image(systemName: "folder")
          .font(.body)
          .frame(width: 32, height: 32)
          .contentShape(Rectangle())
      }
      .accessibilityLabel(railShown ? "Hide project files" : "Show project files")
      Text(project)
        .font(.headline)
        .lineLimit(1)
        .fixedSize()
      if !files.files.isEmpty {
        ScrollView(.horizontal) {
          HStack(spacing: 4) {
            ForEach(files.files, id: \.path) { file in
              tab(file)
            }
          }
        }
        .scrollIndicators(.hidden)
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func tab(_ file: HostFileModel) -> some View {
    let active = file.path == files.activePath
    return HStack(spacing: 4) {
      Button { files.activate(file.path) } label: {
        Text(Fmt.lastComponent(file.path))
          .font(.system(.caption, design: .monospaced))
          .italic(file.isDirty)
          .lineLimit(1)
          .foregroundStyle(active ? .primary : .secondary)
      }
      .buttonStyle(.plain)
      Button { onClose(file) } label: {
        // The dirty dot *is* the close button, as on the dashboard: one target,
        // and the state it carries is the one worth seeing before you press it.
        Image(systemName: file.isDirty ? "circle.fill" : "xmark")
          .font(.system(size: file.isDirty ? 7 : 9, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 18, height: 18)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(
        file.isDirty
          ? "Close \(Fmt.lastComponent(file.path)) (unsaved changes)"
          : "Close \(Fmt.lastComponent(file.path))")
    }
    .padding(.leading, 8)
    .padding(.trailing, 2)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 7)
        .fill(active ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear)))
  }
}

/// One open file's body — the four states `HostFileView` draws, with no header
/// of its own: the path is the tab and Save is in the navigation bar.
private struct EditorFileView: View {
  let file: HostFileModel
  let canWrite: Bool

  @FocusState private var editing: Bool

  var body: some View {
    @Bindable var file = file
    content
      .alert(
        file.conflict ? "File changed on the server" : "Save failed",
        isPresented: Binding(
          get: { file.errorMessage != nil }, set: { if !$0 { file.errorMessage = nil } })
      ) {
        if file.conflict {
          Button("Reload", role: .destructive) { Task { await file.load() } }
          Button("Keep editing", role: .cancel) {}
        } else {
          Button("OK", role: .cancel) {}
        }
      } message: {
        Text(file.errorMessage ?? "")
      }
  }

  @ViewBuilder
  private var content: some View {
    @Bindable var file = file
    switch file.content {
    case .loading:
      centered { ProgressView() }
    case .failed(let message):
      centered {
        ContentUnavailableView {
          Label("Can't open this file", systemImage: "doc.questionmark")
        } description: {
          Text(message)
        } actions: {
          Button("Try again") { Task { await file.load() } }
        }
      }
    case .binary(let bytes):
      centered {
        ContentUnavailableView {
          Label("Binary file", systemImage: "doc.badge.gearshape")
        } description: {
          Text("\(Fmt.bytes(bytes)) that isn't UTF-8 text. Opening it here could only corrupt it.")
        }
      }
    case .text:
      TextEditor(text: $file.draft)
        .font(.system(.footnote, design: .monospaced))
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .scrollContentBackground(.hidden)
        .focused($editing)
        .disabled(!canWrite)
        .toolbar {
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { editing = false }
          }
        }
    }
  }

  private func centered<Body: View>(@ViewBuilder _ body: () -> Body) -> some View {
    VStack { body() }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
