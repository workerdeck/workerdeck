import Foundation
import WorkerDeckCore
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// The session's skills for the skills sheet, and a counter the composer redraws on: its core object reads the
// session itself.
struct CoreComposerContext: Equatable, Sendable {
  var revision = 0
  var skills: [SkillInfo] = []
  var skillSections: [SkillSection] = []
  // Staged files the core sent up again because the session moved on to its next conversation, and a prompt the
  // gateway refused before the engine saw it: each lands in the composer once, by its counter.
  var reuploads: [Reupload] = []
  var reuploadCount = 0
  var undelivered: String?
  var undeliveredCount = 0

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
