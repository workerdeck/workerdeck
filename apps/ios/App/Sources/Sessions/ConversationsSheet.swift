import SwiftUI
import WorkerDeckCore

// A deleted agent in the filter menu's Past agents list; its conversations open the same sheet a live agent's do.
struct PastAgentEntry: Equatable, Identifiable {
  let hostId: UUID
  let agent: PastAgent
  var id: String { "\(hostId.uuidString)/\(agent.id)" }
}

// Any session, named or not; `retired` is a deleted agent from Past agents, whose every conversation opens read-only.
struct ConversationsTarget: Identifiable, Hashable {
  let hostId: UUID
  let sessionId: String
  let name: String
  let title: String?
  let retired: Bool
  var id: String { "\(hostId.uuidString)/\(sessionId)" }

  init?(_ item: ListItem) {
    guard let hostId = item.hostUUID else { return nil }
    self.hostId = hostId
    sessionId = item.sessionId
    name = item.row.agent ?? item.row.title
    title = item.row.title
    retired = false
  }

  init(past: PastAgentEntry) {
    hostId = past.hostId
    sessionId = past.agent.id
    name = past.agent.name
    title = nil
    retired = true
  }
}

// A session's conversations, newest first. The current one opens the session's live screen, a past one (or any of a
// deleted agent's) opens by its number, read-only.
struct ConversationsSheet: View {
  let target: ConversationsTarget
  let model: SessionListModel
  let open: (SessionRoute) -> Void
  @State private var items: [ConversationItem]?
  @State private var failed = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if let items {
          List(items, id: \.n) { item in
            Button(action: { choose(item) }) { row(item) }
              .accessibilityIdentifier("conversation-\(item.n)")
          }
        } else if failed {
          ContentUnavailableView {
            Label("Conversations unavailable", systemImage: "exclamationmark.triangle")
          } actions: {
            Button("Retry") { Task { await load() } }
          }
        } else {
          ProgressView()
        }
      }
      .navigationTitle(target.retired ? "\(target.name) (deleted)" : target.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDetents([.medium, .large])
    .task { await load() }
  }

  private func row(_ item: ConversationItem) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(item.title).foregroundStyle(item.unavailable ? .secondary : .primary).lineLimit(1)
        HStack(spacing: 6) {
          Text(item.date)
          if let duration = item.duration { Text(duration) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
      if item.current {
        Text("Current").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
      }
    }
    .contentShape(Rectangle())
  }

  private func load() async {
    failed = false
    items = await model.conversations(hostId: target.hostId, sessionId: target.sessionId, title: target.title)
    failed = items == nil
  }

  private func choose(_ item: ConversationItem) {
    open(
      .session(
        hostId: target.hostId, sessionId: target.sessionId, conversation: item.current && !target.retired ? nil : item.n))
  }
}
