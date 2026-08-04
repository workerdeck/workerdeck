import WorkerDeckKit
import SwiftUI

/// One host file: read always, edit where the server allows it.
///
/// A plain `TextEditor` in a monospaced font, not a code editor — the app has zero
/// third-party dependencies, and a Tree-sitter editor would be its first. Good
/// enough for the thing a phone is actually for: fixing a line the agent got
/// wrong, not writing a module.
struct HostFileView: View {
  let model: HostFilesModel
  let path: String

  @State private var file: HostFileModel?
  @FocusState private var editing: Bool

  var body: some View {
    Group {
      if let file {
        content(file)
      } else {
        ProgressView()
      }
    }
    .navigationTitle(Fmt.lastComponent(path))
    .navigationBarTitleDisplayMode(.inline)
    .task {
      guard file == nil else { return }
      let live = HostFileModel(client: modelClient, path: path)
      file = live
      await live.load()
    }
  }

  /// The browser model owns the client; the file model needs the same one.
  private var modelClient: WorkerClient { model.client }

  @ViewBuilder
  private func content(_ file: HostFileModel) -> some View {
    @Bindable var file = file
    switch file.content {
    case .loading:
      ProgressView()
    case .failed(let message):
      ContentUnavailableView {
        Label("Can't open this file", systemImage: "doc.questionmark")
      } description: {
        // Covers the interesting refusal too: a symlink pointing outside the
        // server's roots reads as a 403 here, which is the correct answer.
        Text(message)
      } actions: {
        Button("Try again") { Task { await file.load() } }
      }
    case .binary(let bytes):
      ContentUnavailableView {
        Label("Binary file", systemImage: "doc.badge.gearshape")
      } description: {
        Text("\(Fmt.bytes(bytes)) that isn't UTF-8 text. Opening it here could only corrupt it.")
      }
    case .text:
      editor(file)
    }
  }

  @ViewBuilder
  private func editor(_ file: HostFileModel) -> some View {
    @Bindable var file = file
    TextEditor(text: $file.draft)
      .font(.system(.footnote, design: .monospaced))
      .autocorrectionDisabled()
      .textInputAutocapitalization(.never)
      .scrollContentBackground(.hidden)
      .focused($editing)
      .disabled(!model.canWrite)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          if file.saving {
            ProgressView().controlSize(.small)
          } else if model.canWrite {
            Button("Save") { Task { await file.save() } }
              .disabled(!file.isDirty)
          }
        }
        ToolbarItemGroup(placement: .keyboard) {
          Spacer()
          Button("Done") { editing = false }
        }
      }
      .alert(
        file.conflict ? "File changed on the server" : "Save failed",
        isPresented: Binding(
          get: { file.errorMessage != nil },
          set: { if !$0 { file.errorMessage = nil } })
      ) {
        // A conflict is not retryable: something else — most likely the agent —
        // wrote this file since it was read, and forcing would discard that.
        // Reloading is the only honest option, and it costs the local edit.
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
}
