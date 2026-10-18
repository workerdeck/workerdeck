import SwiftUI
@preconcurrency import WorkerDeckSession

// The agent-conversation lines above a transcript: a read-only conversation's banner, a first message a crash may
// have kept from the engine, a new conversation that did not start, and the wait for one that is starting.
struct CoreConversationBars: View {
  let archived: ArchivedView?
  let notice: AgentNotice?
  let starting: Bool
  let goToCurrent: ((String) -> Void)?
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
        if let current = archived.current, let goToCurrent {
          Button("Go to current") { goToCurrent(current) }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
      }
    }
    if let text = notice?.undelivered {
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
    if starting {
      Text("Starting a new conversation…")
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
        .accessibilityIdentifier("handover-starting")
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
