import Foundation
import WorkerDeckCore
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

struct ReturnedPrompt: Equatable, Sendable, Identifiable {
  let id: Int
  let text: String
  let uncertain: Bool
  // Sent attachments are not kept once a message goes out; the bar says to add them again.
  let attachments: Int
}

// The session's skills for the skills sheet, and a counter the composer redraws on: its core object reads the
// session itself.
struct CoreComposerContext: Equatable, Sendable {
  var revision = 0
  var skills: [SkillInfo] = []
  var skillSections: [SkillSection] = []
  // Staged files the core sent up again because the session moved on to its next conversation: they land in the
  // composer once, by the counter.
  var reuploads: [Reupload] = []
  var reuploadCount = 0
  // Prompts the gateway handed back (refused before the engine saw them, or of unknown delivery): each stays until the
  // reader inserts or dismisses it, so a draft typed meanwhile is never overwritten and nothing is lost.
  var returned: [ReturnedPrompt] = []
  var nextReturned = 0

  mutating func read(skills: [Skill]) {
    revision &+= 1
    self.skills = skills.map {
      SkillInfo(
        name: $0.name, description: $0.description, shortDescription: $0.shortDescription, displayName: $0.displayName,
        defaultPrompt: $0.defaultPrompt, scope: $0.scope, enabled: $0.enabled)
    }
    skillSections = WorkerDeckCore.skillSections(skills: skills)
  }
}
