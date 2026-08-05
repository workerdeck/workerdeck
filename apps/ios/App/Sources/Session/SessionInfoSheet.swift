import WorkerDeckKit
import SwiftUI
import UIKit

/// What this session *is*: engine, profile, model, mode, where it runs, which
/// credentials it found, and the files it has handed over.
///
/// The identity half of the old "Session details" list. Context and usage moved
/// to their own sheets — they change every turn and are consulted mid-run, while
/// everything here is fixed at creation and looked up once.
struct SessionInfoSheet: View {
  let state: TranscriptState
  let session: SessionInfo?
  let fileAccess: SessionFileAccess?

  @Environment(\.dismiss) private var dismiss
  @State private var downloader = FileDownloader()

  var body: some View {
    NavigationStack {
      List {
        Section {
          if let model = state.model {
            LabeledContent("Model", value: model)
          }
          if let mode = state.permissionMode {
            LabeledContent("Permission mode", value: mode.label)
          }
          LabeledContent("Engine", value: (session?.resolvedEngine ?? .claude).rawValue)
          if let profile = session?.profile {
            LabeledContent("Profile", value: profile)
          }
          if let apiKeySource = session?.apiKeySource {
            LabeledContent("Credentials", value: apiKeySource)
          }
        }

        Section {
          if let cwd = state.cwd ?? session?.cwd {
            CopyableRow(label: "Working directory", value: cwd)
          }
          if let sdkSessionId = state.sdkSessionId ?? session?.sdkSessionId {
            CopyableRow(label: "SDK session id", value: sdkSessionId)
          }
        }

        SessionFilesSection(access: fileAccess, downloader: downloader)
      }
      .navigationTitle("Session info")
      .navigationBarTitleDisplayMode(.inline)
      .fileDownloadPresentation(downloader)
      .task { downloader.access = fileAccess }
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

/// Long ids are for pasting elsewhere, so give them a tap target.
private struct CopyableRow: View {
  let label: String
  let value: String

  var body: some View {
    Button {
      UIPasteboard.general.string = value
    } label: {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 2) {
          Text(label)
            .font(.caption)
            .foregroundStyle(.secondary)
          Text(value)
            .font(.caption.monospaced())
            .foregroundStyle(.primary)
            .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 8)
        Image(systemName: "doc.on.doc")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Copies \(label.lowercased())")
  }
}
