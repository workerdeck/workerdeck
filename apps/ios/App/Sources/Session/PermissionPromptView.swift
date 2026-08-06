import WorkerDeckKit
import SwiftUI

/// Generic allow/deny prompt for a pending permission request.
///
/// Three outcomes, not two: denying usually means "not that, try something else",
/// so plain Deny lets the turn continue while "Deny & stop" also interrupts.
struct PermissionPromptView: View {
  let request: PermissionRequest
  let onAllow: () -> Void
  let onDeny: (_ message: String?, _ interrupt: Bool) -> Void

  @State private var showDenyMessage = false
  @State private var denyMessage = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "hand.raised.fill")
          .foregroundStyle(.orange)
        Text(request.title ?? request.displayName ?? "Permission needed")
          .font(.subheadline.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)
      }

      if let description = request.description, !description.isEmpty {
        Text(description)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      HStack(spacing: 6) {
        Image(systemName: ToolIcon.symbol(for: request.toolName))
          .font(.caption2)
        Text(request.toolName)
          .font(.caption.weight(.medium))
        if let summary = request.input.toolInputSummary(toolName: request.toolName) {
          Text(summary)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }

      HStack(spacing: 8) {
        Button("Allow", action: onAllow)
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
        Button("Deny") { showDenyMessage = true }
          .buttonStyle(.bordered)
          .controlSize(.small)
        Spacer(minLength: 0)
        Button("Deny & stop", role: .destructive) { onDeny(nil, true) }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
    }
    // The orange card IS the floating panel — it needs a real surface, because
    // it sits over a scrolling transcript. Nesting it inside a neutral glass
    // panel drew two rounded rectangles for one prompt.
    .padding(14)
    .glassPanel(cornerRadius: 20, tint: .orange)
    .alert("Deny this tool call?", isPresented: $showDenyMessage) {
      TextField("Reason (optional)", text: $denyMessage)
      Button("Deny") {
        let message = denyMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        onDeny(message.isEmpty ? nil : message, false)
        denyMessage = ""
      }
      Button("Cancel", role: .cancel) { denyMessage = "" }
    } message: {
      Text("The reason is fed back to the agent, which can then try something else.")
    }
  }
}
