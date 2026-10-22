import SwiftUI
@preconcurrency import WorkerDeckSession

// The conversation lines above a transcript: a past conversation's banner, a first message whose delivery is unknown,
// and a new conversation that did not start.
struct CoreConversationBars: View {
  let archived: ArchivedView?
  let notice: ConversationNotice?
  let goToCurrent: (() -> Void)?
  let settle: (Bool) -> Void
  let retryStartNow: () -> Void

  var body: some View {
    if let archived {
      bar(identifier: "archived-banner") {
        Image(systemName: "clock.arrow.circlepath")
        VStack(alignment: .leading, spacing: 1) {
          Text(archived.banner)
          if let note = archived.note { Text(note).foregroundStyle(.tertiary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if archived.current != nil, let goToCurrent {
          Button("Go to current") { goToCurrent() }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
      }
    }
    if let text = notice?.uncertainPrompt {
      bar(identifier: "undelivered-bar") {
        VStack(alignment: .leading, spacing: 2) {
          Text("The first message may not have been delivered")
          Text(text).lineLimit(2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Button("Send again") { settle(true) }.buttonStyle(.bordered).controlSize(.small)
        Button("Dismiss") { settle(false) }.buttonStyle(.plain)
      }
    }
    if let reason = notice?.startFailed {
      bar(identifier: "retry-start-bar") {
        VStack(alignment: .leading, spacing: 2) {
          Text("The new conversation did not start")
          Text(reason).lineLimit(2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Button("Retry start", action: retryStartNow).buttonStyle(.bordered).controlSize(.small)
      }
    }
  }

  private func bar<Content: View>(identifier: String, @ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 8, content: content)
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
      .padding(.horizontal, 8)
      .padding(.top, 6)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier(identifier)
  }
}

// The asks around a cut: discard input the engine cannot confirm, settle a first message of unknown delivery, and
// delete a named session.
struct CoreConversationDialogs: ViewModifier {
  @Binding var discard: DiscardConfirmation?
  @Binding var settleCut: Int64?
  @Binding var confirmDelete: Bool
  let agentName: String?
  let onDiscard: (DiscardConfirmation) -> Void
  let onSettle: (Bool, Int64) -> Void
  let onDelete: () -> Void

  func body(content: Content) -> some View {
    content
      .confirmationDialog(
        discard?.title ?? "", isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } }),
        titleVisibility: .visible, presenting: discard
      ) { confirmation in
        Button(confirmation.confirm, role: .destructive) { onDiscard(confirmation) }
      } message: { confirmation in
        Text(confirmation.detail)
      }
      .confirmationDialog(
        "The first message may not have arrived",
        isPresented: Binding(get: { settleCut != nil }, set: { if !$0 { settleCut = nil } }),
        titleVisibility: .visible, presenting: settleCut
      ) { n in
        Button("Send again") { onSettle(true, n) }
        Button("Dismiss", role: .destructive) { onSettle(false, n) }
      } message: { _ in
        Text("A new conversation waits until you decide on it.")
      }
      .confirmationDialog(
        deleteAgentTitle(name: agentName ?? "this agent"), isPresented: $confirmDelete, titleVisibility: .visible
      ) {
        Button("Delete agent", role: .destructive, action: onDelete)
      } message: {
        Text(deleteAgentMessage(name: agentName ?? "This agent"))
      }
  }
}
