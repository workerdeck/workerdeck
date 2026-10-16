import Foundation
import WorkerDeckKit

// What the composer needs from the session beyond the chrome. The core folds commands and skills into its state but
// the FFI does not hand them out, so they are read off the frames on their way in; cwd and the attachment kinds come
// from the session info the core does expose.
struct CoreComposerContext: Equatable, Sendable {
  var cwd: String?
  var attachmentKinds: Set<String> = []
  var commands: [SlashCommandInfo] = []
  var skills: [SkillInfo] = []
  // A running top-level Bash or subagent call the engine can move to the background.
  var canSendNow = false

  // A cheap test before any decode: a replay is thousands of frames and nearly none of them carry a list.
  static func mayCarryLists(_ text: String) -> Bool {
    text.contains(#""type":"capabilities""#) || text.contains(#""type":"skills""#)
  }

  // True when a list changed.
  mutating func absorb(_ text: String) -> Bool {
    guard case .event(let event)? = try? JSONDecoder().decode(ServerFrame.self, from: Data(text.utf8)) else {
      return false
    }
    switch event.body {
    case .capabilities(_, let commands, _) where commands != self.commands:
      self.commands = commands
    case .skills(let skills) where skills != self.skills:
      self.skills = skills
    default:
      return false
    }
    return true
  }

  mutating func read(sessionInfoJson json: String?) {
    guard let data = json?.data(using: .utf8),
      let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    cwd = (info["cwd"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let capabilities = info["capabilities"] as? [String: Any]
    attachmentKinds = Set((capabilities?["attachments"] as? [String] ?? []).filter { $0 != "unknown" })
  }
}
