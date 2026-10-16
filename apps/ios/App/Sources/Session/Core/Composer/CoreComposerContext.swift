import Foundation
import WorkerDeckKit
@preconcurrency import WorkerDeckSession

// What the composer needs from the session beyond the chrome, in the kit types the completions already take.
struct CoreComposerContext: Equatable, Sendable {
  var cwd: String?
  var attachmentKinds: Set<String> = []
  var commands: [SlashCommandInfo] = []
  var skills: [SkillInfo] = []
  // A running top-level Bash or subagent call the engine can move to the background, `SEND_NOW_AFTER_MS` old.
  var canSendNow = false

  mutating func read(chrome: SessionChrome, commands: [SlashCommand], skills: [Skill]) {
    cwd = chrome.cwd
    attachmentKinds = Set(chrome.attachmentKinds)
    self.commands = commands.map {
      SlashCommandInfo(name: $0.name, description: $0.description, argumentHint: $0.argumentHint, aliases: $0.aliases)
    }
    self.skills = skills.map {
      SkillInfo(
        name: $0.name, description: $0.description, shortDescription: $0.shortDescription, displayName: $0.displayName,
        defaultPrompt: $0.defaultPrompt, scope: $0.scope, enabled: $0.enabled)
    }
  }
}
