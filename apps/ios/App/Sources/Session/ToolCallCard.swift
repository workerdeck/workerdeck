import WorkerDeckKit
import SwiftUI

/// A tool call: icon, name, one-line input summary and a status chip when
/// collapsed; full input and result when expanded.
///
/// The chip is derived from `status`, never from "does it have a result yet" — a
/// pending or deferred call has no result and is not the same as a running one.
struct ToolCallCard: View {
  let call: ToolCallItem
  @Binding var isExpanded: Bool

  @Environment(\.producedImageLoader) private var producedImages

  /// The host path this call says it wrote, when the engine reported one. Only
  /// `savedPath` — a file the agent merely *read* is not a produced file and
  /// has no route to fetch it from.
  private var producedPath: String? {
    call.input["savedPath"]?.stringValue
  }

  var body: some View {
    content
      .padding(10)
      .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
      .overlay(
        RoundedRectangle(cornerRadius: 10)
          .strokeBorder(call.status == .failed ? Color.red.opacity(0.35) : Color.clear))
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        isExpanded.toggle()
      } label: {
        header
      }
      .buttonStyle(.plain)

      // Shown collapsed as well as expanded: for an image-generating call the
      // picture *is* the result, and hiding it behind a disclosure would make
      // the one interesting turn look like the others.
      if let path = producedPath, producedImages?.hasImage(forPath: path) == true {
        producedImage(path)
      }

      if isExpanded {
        detail
      }
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: ToolIcon.symbol(for: call.name))
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(width: 16)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(call.name)
            .font(.caption.weight(.semibold))
          if let backend = call.backend, backend != "server" {
            Text(backend)
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
        if let summary = call.input.toolInputSummary(toolName: call.name) {
          Text(summary)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 0)
      StatusChip(status: call.status)
    }
    .contentShape(Rectangle())
  }

  private func producedImage(_ path: String) -> some View {
    Group {
      if let image = producedImages?.image(forPath: path) {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity)
          .clipShape(RoundedRectangle(cornerRadius: 8))
      } else {
        RoundedRectangle(cornerRadius: 8)
          .fill(Color.secondary.opacity(0.12))
          .frame(height: 120)
          .overlay(ProgressView().controlSize(.small))
      }
    }
    .task(id: path) { producedImages?.load(path: path) }
    .accessibilityLabel("Generated image")
  }

  @ViewBuilder
  private var detail: some View {
    VStack(alignment: .leading, spacing: 8) {
      MonospacedBlock(title: "Input", text: call.input.prettyJSON, isError: false)

      if let result = call.result, !result.text.isEmpty {
        MonospacedBlock(
          title: result.isError ? "Error" : "Result", text: result.text, isError: result.isError)
      }

      if let logs = call.logs, !logs.isEmpty {
        MonospacedBlock(title: "Logs", text: logs.joined(separator: "\n"), isError: false)
      }
    }
  }
}

/// Status pill: spinner while the model is running it, clock while an executor
/// holds it, check/cross once terminal.
private struct StatusChip: View {
  let status: ToolCallStatus

  var body: some View {
    switch status {
    case .running:
      ProgressView().controlSize(.mini)
    case .pending, .deferred:
      glyph(symbol: status == .deferred ? "clock.badge" : "clock")
        .foregroundStyle(.orange)
        .accessibilityLabel(status == .deferred ? "Deferred" : "Pending")
    case .settled:
      glyph(symbol: "checkmark")
        .foregroundStyle(.green)
        .accessibilityLabel("Done")
    case .failed:
      glyph(symbol: "xmark")
        .foregroundStyle(.red)
        .accessibilityLabel("Failed")
    }
  }

  private func glyph(symbol: String) -> some View {
    Image(systemName: symbol).font(.caption.weight(.semibold))
  }
}

/// Scrollable monospaced block. Capped in height so one 4000-line tool result
/// can't push the rest of the transcript off screen.
private struct MonospacedBlock: View {
  let title: String
  let text: String
  let isError: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
      ScrollView(.vertical) {
        Text(text)
          .font(.caption.monospaced())
          .foregroundStyle(isError ? Color.red : Color.primary)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 260)
      .padding(8)
      .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
    }
  }
}
