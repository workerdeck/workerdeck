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
  @Environment(\.transcriptVariant) private var variant

  /// The host path this call says it wrote, when the engine reported one. Only
  /// `savedPath` — a file the agent merely *read* is not a produced file and
  /// has no route to fetch it from.
  private var producedPath: String? {
    call.input["savedPath"]?.stringValue
  }

  var body: some View {
    if variant.isLines {
      // No box: the tool's own icon sits in the gutter and carries the row, the
      // way `⎿` carries the result line under it in the CLI.
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        // A character, not an SF Symbol — and the same one the web transcript
        // uses: the mark's pulse while the call is running, a plain `●` once it
        // has settled, which reads as "done" precisely by not moving. The tool's
        // *name* is right there saying which tool it is; a per-tool icon was
        // the one drawn thing left in a variant whose claim is that it draws
        // nothing.
        LineGlyphBox(color: gutterColor) {
          if call.status == .running { PulseGlyph() } else { Text("●") }
        }
        content
      }
    } else {
      content
        .padding(10)
        .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
          RoundedRectangle(cornerRadius: 10)
            .strokeBorder(call.status == .failed ? Color.red.opacity(0.35) : Color.clear))
    }
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

  /// A settled write is green: skimming a run, "what did it change" is the
  /// question you come back to, and the one you might need to undo. Everything
  /// else keeps its own state colour — a failed write is a failure first.
  private var gutterColor: Color {
    if call.status == .failed { return .red }
    if call.status == .settled, ToolIcon.isMutating(call.name) { return .green }
    return .secondary
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      // In `lines` the icon has moved to the gutter, so the header starts at the
      // name — two copies of it would break the column the gutter establishes.
      if !variant.isLines {
        Image(systemName: ToolIcon.symbol(for: call.name))
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(width: 16)
      }
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(call.name)
            .rowFont(.caption.weight(.semibold), lines: lineTextStyle.weight(.semibold))
          if let backend = call.backend, backend != "server" {
            Text(backend)
              .rowFont(.caption2, lines: .caption)
              .foregroundStyle(.secondary)
          }
        }
        if let summary = call.input.toolInputSummary(toolName: call.name) {
          Text(summary)
            .rowFont(.caption.monospaced(), lines: lineTextStyle.monospaced())
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

  @Environment(\.transcriptVariant) private var variant

  var body: some View {
    switch status {
    case .running:
      // Nothing: in `lines` the gutter glyph is already pulsing, and two
      // animations on one row is one too many. `cards` has no gutter, so it
      // keeps the spinner.
      if !variant.isLines {
        ProgressView().controlSize(.mini)
      }
    case .pending, .deferred:
      glyph(text: status == .deferred ? "⧗" : "·", symbol: status == .deferred ? "clock.badge" : "clock")
        .foregroundStyle(.orange)
        .accessibilityLabel(status == .deferred ? "Deferred" : "Pending")
    case .settled:
      glyph(text: "✓", symbol: "checkmark")
        .foregroundStyle(.green)
        .accessibilityLabel("Done")
    case .failed:
      glyph(text: "✗", symbol: "xmark")
        .foregroundStyle(.red)
        .accessibilityLabel("Failed")
    }
  }

  /// The same state, spelled the way its variant spells things: a character in
  /// `lines`, an SF Symbol in `cards`.
  @ViewBuilder
  private func glyph(text: String, symbol: String) -> some View {
    if variant.isLines {
      Text(text).font(lineTextStyle.weight(.semibold).monospaced())
    } else {
      Image(systemName: symbol).font(.caption.weight(.semibold))
    }
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
