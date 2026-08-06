import WorkerDeckKit
import SwiftUI

/// What this session's engine can do beyond its own tools: the skills it found,
/// grouped by where they came from, with a detail screen each.
///
/// The framing matters more here than in most sheets. A skill is **not** a
/// command — the model decides to use one by reading its description, and there
/// is no wire syntax that invokes it. So this is a *discovery* screen, and the
/// one action it offers ("Use this skill") is honest about being a drafting
/// aid: it types a message into the composer for the operator to edit and send.
///
/// Fed from the session's `skills` event rather than a request, because that is
/// the channel the engine refreshes on its own when a skill changes on disk.
struct SkillsView: View {
  let skills: [SkillInfo]
  let onUse: (SkillInfo) -> Void

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if skills.isEmpty {
          ContentUnavailableView {
            Label("No skills", systemImage: "sparkles")
          } description: {
            Text("This session found no skills.")
          }
        } else {
          list
        }
      }
      .navigationTitle("Skills")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }

  private var list: some View {
    List {
      ForEach(scopes, id: \.self) { scope in
        Section(scopeTitle(scope)) {
          ForEach(skills.filter { ($0.scope ?? "other") == scope }) { skill in
            NavigationLink {
              SkillDetailView(skill: skill, onUse: onUse)
            } label: {
              SkillRow(skill: skill)
            }
          }
        }
      }
    } .listStyle(.insetGrouped)
  }

  /// Closest first — the project you are in, then your own, then whatever the
  /// host or an admin put there.
  private var scopes: [String] {
    let order = ["repo", "user", "system", "admin"]
    let present = Set(skills.map { $0.scope ?? "other" })
    return order.filter(present.contains) + present.subtracting(order).sorted()
  }

  private func scopeTitle(_ scope: String) -> String {
    switch scope {
    case "repo": return "This project"
    case "user": return "Personal"
    case "system": return "System"
    case "admin": return "Managed"
    default: return scope.capitalized
    }
  }
}

private struct SkillRow: View {
  let skill: SkillInfo

  var body: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(skill.displayName ?? skill.name)
          .font(.callout)
          .lineLimit(1)
        if let summary = skill.shortDescription ?? skill.description, !summary.isEmpty {
          Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
      Spacer(minLength: 0)
      // Listed but switched off is a different answer from absent, and the one
      // an operator hunting for a missing skill needs.
      if !skill.enabled {
        Text("Off")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct SkillDetailView: View {
  let skill: SkillInfo
  let onUse: (SkillInfo) -> Void

  var body: some View {
    List {
      Section {
        if let scope = skill.scope {
          LabeledContent("Scope", value: scope.capitalized)
        }
        LabeledContent("Status", value: skill.enabled ? "Enabled" : "Disabled")
      }
      if let description = skill.description, !description.isEmpty {
        Section("Description") {
          // Verbatim: this is the text the MODEL selects on, so paraphrasing it
          // would describe a different skill than the one the agent is reading.
          Text(description)
            .font(.callout)
            .foregroundStyle(.secondary)
        }
      }
      if skill.enabled {
        Section {
          Button("Use this skill") { onUse(skill) }
        } footer: {
          Text(
            "Writes an opening message into the composer for you to edit — it isn’t sent, and "
              + "there is no command that runs a skill directly.")
        }
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle(skill.displayName ?? skill.name)
    .navigationBarTitleDisplayMode(.inline)
  }
}
