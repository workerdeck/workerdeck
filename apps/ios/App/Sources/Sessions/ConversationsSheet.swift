import SwiftUI
import WorkerDeckCore

// A deleted agent in the filter menu's Past agents list; its conversations open the same sheet a live agent's do.
struct PastAgentEntry: Equatable, Identifiable {
  let hostId: UUID
  let agent: PastAgent
  var id: String { "\(hostId.uuidString)/\(agent.id)" }
}

struct ConversationsTarget: Identifiable, Hashable {
  let hostId: UUID
  let agentId: String
  let name: String
  let retired: Bool
  var id: String { "\(hostId.uuidString)/\(agentId)" }

  init?(_ item: ListItem) {
    guard let hostId = item.hostUUID, let agentId = item.row.agentId else { return nil }
    self.hostId = hostId
    self.agentId = agentId
    name = item.row.agent ?? item.row.title
    retired = false
  }

  init(past: PastAgentEntry) {
    hostId = past.hostId
    agentId = past.agent.id
    name = past.agent.name
    retired = true
  }
}

// An agent's conversations, newest first. The current one opens the agent view (which follows); a past one opens
// read-only and never follows.
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
          List(items, id: \.sessionId) { item in
            Button(action: { choose(item) }) { row(item) }
              .accessibilityIdentifier("conversation-\(item.sessionId)")
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
    items = await model.conversations(hostId: target.hostId, agentId: target.agentId)
    failed = items == nil
  }

  private func choose(_ item: ConversationItem) {
    open(
      item.current && !target.retired
        ? .session(hostId: target.hostId, sessionId: item.sessionId)
        : .conversation(hostId: target.hostId, sessionId: item.sessionId))
  }
}
