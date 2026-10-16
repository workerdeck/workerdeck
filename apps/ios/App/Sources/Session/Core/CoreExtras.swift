import Observation
import SwiftUI
import WorkerDeckKit

enum CoreExtrasSheet: String, Identifiable {
  case info, files, mcp, skills
  var id: String { rawValue }
}

// The info, MCP, skills and host-file sheets: state for the menu and the sheets, read from REST and the skills event.
@MainActor
@Observable
final class CoreExtras {
  var sheet: CoreExtrasSheet?
  private(set) var info: SessionInfo?

  var capabilities: EngineCapabilities? { info?.resolvedCapabilities }

  func load(client: WorkerClient, sessionId: String) async {
    info = try? await client.getSession(id: sessionId)
  }
}

struct CoreExtrasMenu: View {
  let extras: CoreExtras

  var body: some View {
    Divider()
    Button("Session info", systemImage: "info.circle") { extras.sheet = .info }
    if extras.info?.cwd != nil {
      Button("Files", systemImage: "folder") { extras.sheet = .files }
    }
    if extras.capabilities?.mcpStatus == true {
      Button("MCP servers", systemImage: "puzzlepiece.extension") { extras.sheet = .mcp }
    }
    if extras.capabilities?.skillsList == true {
      Button("Skills", systemImage: "sparkles") { extras.sheet = .skills }
    }
  }
}

struct CoreExtrasSheets: ViewModifier {
  @Bindable var extras: CoreExtras
  let model: CoreSessionModel
  let client: WorkerClient?
  let sessionId: String
  @Binding var draft: String

  func body(content: Content) -> some View {
    content
      .task { if let client { await extras.load(client: client, sessionId: sessionId) } }
      .sheet(item: $extras.sheet) { sheet in
        if let client {
          switch sheet {
          case .info:
            SessionInfoSheet(chrome: model.ui.chrome, session: extras.info, fileAccess: fileAccess(client))
          case .files:
            if let cwd = extras.info?.cwd { HostFilesView(scope: HostFileScope(client: client, cwd: cwd)) }
          case .mcp:
            McpServersView(
              load: { try await client.listMcpServers(sessionId: sessionId) },
              act: { name, action in
                try await client.mcpServerAction(sessionId: sessionId, serverName: name, action: action)
              },
              canManage: extras.capabilities?.mcpServerActions ?? false)
          case .skills:
            SkillsView(skills: model.skills ?? [], onUse: use)
          }
        }
      }
  }

  private func fileAccess(_ client: WorkerClient) -> SessionFileAccess {
    SessionFileAccess(
      list: { try await client.listSessionFiles(sessionId: sessionId) },
      download: { path in
        let data = try await client.fetchSessionFile(sessionId: sessionId, path: path)
        return try SessionFileAccess.writeTemporary(data, named: Fmt.lastComponent(path))
      })
  }

  private func use(_ skill: SkillInfo) {
    let trimmed = skill.defaultPrompt?.trimmingCharacters(in: .whitespacesAndNewlines)
    let base = trimmed?.isEmpty == false ? trimmed! : "$\(skill.name)"
    let separator = draft.isEmpty || draft.hasSuffix(" ") ? "" : " "
    draft += separator + base + (base.hasSuffix(" ") ? "" : " ")
    extras.sheet = nil
  }
}
