import SwiftUI
import WorkerDeckCore

/// Add/edit form for one gateway. The same view for both - `Host` carries its own
/// id, so "new" is just a `Host()` with empty fields.
struct HostEditorView: View {
  @Environment(\.dismiss) private var dismiss

  @State private var draft: Host
  private let isNew: Bool
  private let onSave: (Host) -> Void

  init(host: Host, onSave: @escaping (Host) -> Void) {
    _draft = State(initialValue: host)
    isNew = host.baseURL.isEmpty && host.name.isEmpty
    self.onSave = onSave
  }

  var body: some View {
    Form {
      Section {
        TextField("Name", text: $draft.name)
          .textInputAutocapitalization(.words)
      } footer: {
        Text("Optional - the address is used when this is blank.")
      }

      Section {
        TextField("https://your-mac.tailnet-name.ts.net", text: $draft.baseURL)
          .keyboardType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .onChange(of: draft.baseURL) { _, text in applyPairingLink(text) }
      } header: {
        Text("Server address")
      } footer: {
        // The API prefix is protocol plumbing, not something to memorize.
        Text("The gateway root, or paste a pairing link from Enable Remote Access. `/v1` is appended automatically.")
      }

      Section {
        SecureField("Auth key", text: $draft.authKey)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      } header: {
        Text("Authentication")
      } footer: {
        Text("The server's `--auth-key`. Leave blank for an unauthenticated gateway. Stored in the iOS Keychain.")
      }
    }
    .navigationTitle(isNew ? "Add server" : "Edit server")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") { dismiss() }
      }
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          onSave(draft)
          dismiss()
        }
        .disabled(!draft.isValid)
      }
    }
  }

  // A pairing link carries the key in its fragment: split it into the two fields so the key never sits in the address.
  private func applyPairingLink(_ text: String) {
    guard let link = parsePairingLink(text: text) else { return }
    draft.baseURL = link.baseUrl
    draft.authKey = link.key
    if draft.name.trimmingCharacters(in: .whitespaces).isEmpty {
      draft.name = gatewayName(baseUrl: link.baseUrl)
    }
  }
}
