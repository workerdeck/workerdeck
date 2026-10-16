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
