import SwiftUI

/// The saved gateways. Doubles as the app's root (no host selected yet) and as
/// the switcher sheet reached from the session list, hence the `dismiss` on
/// selection — a no-op at the root of a stack, a close when presented.
struct HostListView: View {
  @Environment(HostStore.self) private var hosts
  @Environment(\.dismiss) private var dismiss

  @State private var editing: Host?
  @State private var pendingDelete: Host?

  var body: some View {
    List {
      if hosts.hosts.isEmpty {
        ContentUnavailableView {
          Label("No servers", systemImage: "server.rack")
        } description: {
          Text("Add the workerdeck gateway you run — typically over Tailscale.")
        } actions: {
          Button("Add server") { editing = Host() }
            .buttonStyle(.borderedProminent)
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }

      ForEach(hosts.hosts) { host in
        Button {
          hosts.select(host.id)
          dismiss()
        } label: {
          HostRow(host: host, isSelected: host.id == hosts.selectedHostID)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
          Button(role: .destructive) { pendingDelete = host } label: {
            Label("Delete", systemImage: "trash")
          }
          Button { editing = host } label: {
            Label("Edit", systemImage: "pencil")
          }
          .tint(.blue)
        }
      }
    }
    .navigationTitle("Servers")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button { editing = Host() } label: {
          Label("Add server", systemImage: "plus")
        }
      }
    }
    .sheet(item: $editing) { host in
      NavigationStack {
        HostEditorView(host: host) { edited in
          hosts.upsert(edited)
        }
      }
    }
    .confirmationDialog(
      "Delete “\(pendingDelete?.displayName ?? "")”?",
      isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        if let host = pendingDelete { hosts.delete(host) }
        pendingDelete = nil
      }
      Button("Cancel", role: .cancel) { pendingDelete = nil }
    } message: {
      Text("The saved address and auth key are removed from this device. The server keeps running.")
    }
  }
}

private struct HostRow: View {
  let host: Host
  let isSelected: Bool

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary.opacity(0.5))
        .imageScale(.large)
      VStack(alignment: .leading, spacing: 2) {
        Text(host.displayName)
          .font(.body)
          .foregroundStyle(.primary)
        HStack(spacing: 6) {
          Text(host.displayAddress)
          if host.authKey.isEmpty {
            Text("no auth key")
              .foregroundStyle(.orange)
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .contentShape(Rectangle())
  }
}
