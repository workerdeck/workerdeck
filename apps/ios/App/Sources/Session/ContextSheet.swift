import WorkerDeckKit
import SwiftUI

/// What is in the model's context window right now, category by category.
///
/// One of three sheets the status bar and the toolbar menu open — context, usage
/// and session info were a single "Session details" list, which meant scrolling
/// past two answers to reach the third. They are different questions asked at
/// different moments, so they are different screens.
struct ContextSheet: View {
  let usage: ContextUsage?

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if let usage {
          List {
            Section {
              LabeledContent("Used") {
                Text("\(Fmt.tokens(usage.totalTokens)) / \(Fmt.tokens(usage.maxTokens))")
                  .monospacedDigit()
              }
              ContextBar(usage: usage)
            } footer: {
              if let model = usage.model {
                Text(model)
              }
            }
            Section("Breakdown") {
              ForEach(Array(usage.categories.enumerated()), id: \.offset) { _, category in
                CategoryRow(category: category, maxTokens: max(usage.maxTokens, 1))
              }
            }
          }
        } else {
          ContentUnavailableView {
            Label("No reading yet", systemImage: "chart.pie")
          } description: {
            Text("The context window is measured after a turn completes.")
          }
        }
      }
      .navigationTitle("Context")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

private struct CategoryRow: View {
  let category: ContextUsageCategory
  let maxTokens: Int

  /// The protocol's `color` is *usually* a CLI theme token rather than a real
  /// color, so it is honoured only when it parses — same rule as the dashboard.
  private var tint: Color { Color(cliToken: category.color) ?? .accentColor }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Circle()
          .fill(tint)
          .frame(width: 7, height: 7)
        Text(category.name)
          .font(.caption)
        Spacer(minLength: 0)
        Text(Fmt.tokens(category.tokens))
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      ProgressView(value: Double(category.tokens), total: Double(maxTokens))
        .progressViewStyle(.linear)
        .tint(tint)
    }
    .padding(.vertical, 2)
  }
}
