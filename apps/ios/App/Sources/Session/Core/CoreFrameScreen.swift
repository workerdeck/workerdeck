import SwiftUI
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The sub-agent takeover, Android's FrameScreen: the agent's own rows and rail, no composer (you talk to the session),
// but approvals stay, since a sub-agent's calls raise session-level requests.
struct CoreFrameScreen: View {
  let model: CoreSessionModel
  let taskId: String
  let imageLoader: TerminalImageLoader
  let hideThinking: Bool
  @State private var scroll = TranscriptScrollModel()

  var body: some View {
    let ui = model.ui
    let strip = ui.frame?.taskId == taskId ? ui.frame?.strip : nil
    VStack(spacing: 0) {
      if let strip, let text = strip.text {
        stripLine(strip, text)
        Divider()
      }
      if let progress = ui.progress {
        ProgressView(value: Double(progress.seq), total: Double(max(progress.target, 1)))
          .padding(24)
          .frame(maxHeight: .infinity)
      } else if strip != nil && strip?.text == nil {
        Text("This sub-agent's work is not in this transcript.")
          .foregroundStyle(.secondary)
          .padding(24)
          .frame(maxHeight: .infinity)
      } else {
        CoreTranscriptView(
          model: model, frame: taskId, scroll: scroll, imageLoader: imageLoader, hideThinking: hideThinking)
      }
      if let prompt = ui.prompt {
        Divider()
        CorePromptCard(prompt: prompt, planLines: ui.planLines, model: model)
          .id(prompt.requestId)
      }
    }
    .navigationTitle(strip?.name ?? "Sub-agent")
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("frame-screen")
  }

  private func stripLine(_ strip: FrameStrip, _ text: String) -> some View {
    let tone: TermTone = strip.failed ? .red : strip.busy ? .mark : .dim
    return HStack(spacing: 0) {
      Text(strip.glyph).frame(width: TerminalTypography.session.cell * 2, alignment: .leading)
      Text(text).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 0)
    }
    .font(TerminalTypography.session.font)
    .foregroundStyle(TerminalPalette.color(tone))
    .padding(.horizontal, 8)
    .padding(.vertical, 6)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("frame-strip")
  }
}
