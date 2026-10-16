import Observation
import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

enum CoreExtrasSheet: String, Identifiable {
  case info, files, mcp, skills
  var id: String { rawValue }
}

// The info, MCP, skills and host-file sheets: what the menu offers comes from the core's reading of the session.
@MainActor
@Observable
final class CoreExtras {
  var sheet: CoreExtrasSheet?
  private(set) var facts = sessionExtrasUnknown()

  func load(client: WorkerClient, sessionId: String) async {
    guard let body = try? await client.perform(getSessionCall(id: sessionId)),
      let read = sessionExtras(body: String(decoding: body, as: UTF8.self))
    else { return }
    facts = read
  }
}

struct CoreExtrasMenu: View {
  let extras: CoreExtras

  var body: some View {
    Divider()
    Button("Session info", systemImage: "info.circle") { extras.sheet = .info }
    if extras.facts.files {
      Button("Files", systemImage: "folder") { extras.sheet = .files }
    }
    if extras.facts.mcp {
      Button("MCP servers", systemImage: "puzzlepiece.extension") { extras.sheet = .mcp }
    }
    if extras.facts.skills {
      Button("Skills", systemImage: "sparkles") { extras.sheet = .skills }
    }
  }
}

struct CoreExtrasSheets: ViewModifier {
  @Bindable var extras: CoreExtras
  let model: CoreSessionModel
  let client: WorkerClient?
  let sessionId: String

  func body(content: Content) -> some View {
    content
      .task { if let client { await extras.load(client: client, sessionId: sessionId) } }
      .sheet(item: $extras.sheet) { sheet in
        if let client {
          switch sheet {
          case .info:
            SessionInfoSheet(chrome: model.ui.chrome, facts: extras.facts, fileAccess: fileAccess(client))
          case .files:
            if let cwd = extras.facts.cwd { HostFilesView(scope: HostFileScope(client: client, cwd: cwd)) }
          case .mcp:
            McpServersView(
              model: McpServersModel(
                servers: McpServers(sessionId: sessionId, canManage: extras.facts.mcpCanManage),
                transport: { await client.answer($0) }))
          case .skills:
            SkillsView(sections: model.skillSections, onUse: use)
          }
        }
      }
  }

  private func fileAccess(_ client: WorkerClient) -> SessionFileAccess {
    let sessionId = sessionId
    return SessionFileAccess(
      list: {
        let body = try await client.perform(sessionFilesCall(sessionId: sessionId))
        return sessionFiles(body: String(decoding: body, as: UTF8.self)) ?? []
      },
      download: { path in
        let (data, _) = try await client.fetch(sessionFileCall(sessionId: sessionId, path: path))
        return try SessionFileAccess.writeTemporary(data, named: Fmt.lastComponent(path))
      })
  }

  private func use(_ skill: Skill) {
    let trimmed = skill.defaultPrompt?.trimmingCharacters(in: .whitespacesAndNewlines)
    let base = trimmed?.isEmpty == false ? trimmed! : "$\(skill.name)"
    model.insertion = base
    extras.sheet = nil
  }
}
