import WorkerDeckKit
import SwiftUI

/// One stored SDK session: title, directory, branch, age. Internal rather than
/// private because the create form's resume picker draws the same rows — a
/// stored session should look the same wherever it is offered.
struct SdkSessionRowView: View {
  let summary: SdkSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(summary.summary.isEmpty ? summary.sessionId : summary.summary)
        .font(.body)
        .lineLimit(2)
      HStack(spacing: 8) {
        if let cwd = summary.cwd {
          Text(Fmt.lastComponent(cwd))
            .lineLimit(1)
        }
        if let branch = summary.gitBranch, !branch.isEmpty {
          Label(branch, systemImage: "arrow.branch")
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        Text(Fmt.ago(epochMs: summary.lastModified))
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .padding(.vertical, 3)
  }
}
