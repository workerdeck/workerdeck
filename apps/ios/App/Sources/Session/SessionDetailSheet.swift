import WorkerDeckKit
import SwiftUI
import UIKit

/// Everything the compact HUD couldn't fit: the context-window breakdown, every
/// rate-limit window, and the session's identifying facts.
struct SessionDetailSheet: View {
  let state: TranscriptState
  let session: SessionInfo?
  let rateLimits: [(key: String, info: RateLimitInfo)]
  let fileAccess: SessionFileAccess?

  @Environment(\.dismiss) private var dismiss
  @State private var downloader = FileDownloader()

  var body: some View {
    NavigationStack {
      List {
        if let usage = state.contextUsage {
          Section {
            LabeledContent("Used") {
              Text("\(Fmt.tokens(usage.totalTokens)) / \(Fmt.tokens(usage.maxTokens))")
                .monospacedDigit()
            }
            ContextBar(usage: usage)
            ForEach(Array(usage.categories.enumerated()), id: \.offset) { _, category in
              CategoryRow(category: category, maxTokens: max(usage.maxTokens, 1))
            }
          } header: {
            Text("Context window")
          } footer: {
            if let model = usage.model {
              Text(model)
            }
          }
        }

        SessionFilesSection(access: fileAccess, downloader: downloader)

        if !rateLimits.isEmpty {
          Section("Rate limits") {
            ForEach(rateLimits, id: \.key) { window in
              RateLimitRow(key: window.key, info: window.info)
            }
          }
        }

        Section("Session") {
          if let model = state.model {
            LabeledContent("Model", value: model)
          }
          if let mode = state.permissionMode {
            LabeledContent("Permission mode", value: mode.label)
          }
          LabeledContent("Engine", value: (session?.resolvedEngine ?? .claude).rawValue)
          if let profile = session?.profile {
            LabeledContent("Profile", value: profile)
          }
          LabeledContent("Cost") {
            Text(Fmt.cost(state.totalCostUsd)).monospacedDigit()
          }
          if let cwd = state.cwd ?? session?.cwd {
            CopyableRow(label: "Working directory", value: cwd)
          }
          if let sdkSessionId = state.sdkSessionId ?? session?.sdkSessionId {
            CopyableRow(label: "SDK session id", value: sdkSessionId)
          }
          if let apiKeySource = session?.apiKeySource {
            LabeledContent("Credentials", value: apiKeySource)
          }
        }
      }
      .navigationTitle("Session details")
      .navigationBarTitleDisplayMode(.inline)
      .fileDownloadPresentation(downloader)
      .task { downloader.access = fileAccess }
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

private struct RateLimitRow: View {
  let key: String
  let info: RateLimitInfo

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(Fmt.rateLimitWindow(key))
          .font(.callout.weight(.medium))
        Spacer(minLength: 0)
        if let utilization = info.utilization {
          Text(Fmt.percent(utilization))
            .font(.callout.monospacedDigit())
        }
      }
      HStack(spacing: 8) {
        Text(info.status)
        if let resetsAt = info.resetsAt {
          ResetCountdown(resetsAt: resetsAt, prefix: "resets")
        }
        if info.isUsingOverage == true {
          Text("overage")
            .foregroundStyle(.orange)
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      if let utilization = info.utilization {
        ProgressView(value: min(max(utilization, 0), 100), total: 100)
          .progressViewStyle(.linear)
      }
    }
    .padding(.vertical, 2)
  }
}

/// Long ids are for pasting elsewhere, so give them a tap target.
private struct CopyableRow: View {
  let label: String
  let value: String

  var body: some View {
    Button {
      UIPasteboard.general.string = value
    } label: {
      HStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 2) {
          Text(label)
            .font(.caption)
            .foregroundStyle(.secondary)
          Text(value)
            .font(.caption.monospaced())
            .foregroundStyle(.primary)
            .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 8)
        Image(systemName: "doc.on.doc")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Copies \(label.lowercased())")
  }
}
