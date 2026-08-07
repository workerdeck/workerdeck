import WorkerDeckKit
import SwiftUI

/// The `/mcp` screens, as a navigation stack: servers → one server → its tools →
/// one tool.
///
/// Claude's iOS app has nothing like this; the model is Claude Code's own `/mcp`
/// picker, which is what someone driving a CLI session from a phone already knows.
/// Its four levels are kept, and so is its grouping by scope — "which of my
/// `.mcp.json` files is this one from" is most of the question when a server is
/// misbehaving.
///
/// One thing the CLI shows and this cannot: a tool's parameters. The engine's
/// status payload names and describes each tool but carries no input schema.
struct McpServersView: View {
  let load: () async throws -> [McpServerStatusInfo]
  let act: (String, McpServerActionRequest.Action) async throws -> [McpServerStatusInfo]
  /// Whether this engine can reconnect/enable/disable ONE server
  /// (`EngineCapabilities.mcpServerActions`). False renders read-only.
  var canManage: Bool = true

  @Environment(\.dismiss) private var dismiss
  @State private var servers: [McpServerStatusInfo] = []
  @State private var errorText: String?
  @State private var isLoading = true

  var body: some View {
    NavigationStack {
      Group {
        if isLoading && servers.isEmpty {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorText, servers.isEmpty {
          ContentUnavailableView {
            Label("No MCP servers", systemImage: "puzzlepiece.extension")
          } description: {
            Text(errorText)
          }
        } else if servers.isEmpty {
          ContentUnavailableView {
            Label("No MCP servers", systemImage: "puzzlepiece.extension")
          } description: {
            Text("This session has no MCP servers configured.")
          }
        } else {
          list
        }
      }
      .navigationTitle("MCP servers")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      .task { await refresh() }
      .refreshable { await refresh() }
    }
  }

  private var list: some View {
    List {
      // Grouped by where they were configured, in the CLI's own order: the
      // project you are in, then your own, then anything the host injected.
      ForEach(scopes, id: \.self) { scope in
        Section(scopeTitle(scope)) {
          ForEach(servers.filter { ($0.scope ?? "other") == scope }) { server in
            NavigationLink {
              McpServerDetailView(server: server, canManage: canManage, act: perform)
            } label: {
              McpServerRow(server: server)
            }
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .overlay(alignment: .bottom) {
      if let errorText {
        Text(errorText)
          .font(.caption)
          .foregroundStyle(.orange)
          .padding(10)
          .frame(maxWidth: .infinity)
          .background(.regularMaterial)
      }
    }
  }

  private var scopes: [String] {
    let order = ["project", "local", "user", "dynamic", "managed", "claudeai"]
    let present = Set(servers.map { $0.scope ?? "other" })
    return order.filter(present.contains) + present.subtracting(order).sorted()
  }

  private func scopeTitle(_ scope: String) -> String {
    switch scope {
    case "project": return "Project MCPs"
    case "local": return "Local MCPs"
    case "user": return "User MCPs"
    case "dynamic": return "Session MCPs"
    case "managed": return "Managed MCPs"
    case "claudeai": return "Connectors"
    default: return "Other MCPs"
    }
  }

  private func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      servers = try await load()
      errorText = nil
    } catch {
      errorText = (error as? WorkerClientError)?.message ?? error.localizedDescription
    }
  }

  /// Actions answer with the refreshed list, so one call updates every screen
  /// under this stack — the detail view reads its server back out of `servers`.
  private func perform(_ name: String, _ action: McpServerActionRequest.Action) async {
    do {
      servers = try await act(name, action)
      errorText = nil
    } catch {
      errorText = (error as? WorkerClientError)?.message ?? error.localizedDescription
    }
  }
}

/// One row on the servers list: name, status dot, tool count — the CLI's line.
private struct McpServerRow: View {
  let server: McpServerStatusInfo

  var body: some View {
    HStack(spacing: 10) {
      McpStatusDot(status: server.status)
      VStack(alignment: .leading, spacing: 2) {
        Text(server.name)
          .font(.body.monospaced())
          .lineLimit(1)
          .truncationMode(.middle)
        HStack(spacing: 4) {
          Text(server.status)
          if server.isConnected {
            Text("·")
            Text("\(server.toolCount) tool\(server.toolCount == 1 ? "" : "s")")
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
  }
}

/// The CLI's ✔ / ✗ / ○, as a dot.
struct McpStatusDot: View {
  let status: String

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 8, height: 8)
      .accessibilityLabel(status)
  }

  private var color: Color {
    switch status {
    case "connected": return .green
    case "failed": return .red
    case "needs-auth": return .orange
    case "pending": return .yellow
    default: return .secondary
    }
  }
}

/// One server: everything the CLI's server screen shows, then its three actions
/// — where the engine has them. Codex reports rich status but exposes no
/// per-server action, so its screen is read-only.
private struct McpServerDetailView: View {
  let server: McpServerStatusInfo
  let canManage: Bool
  let act: (String, McpServerActionRequest.Action) async -> Void

  @State private var inFlight: McpServerActionRequest.Action?

  var body: some View {
    List {
      Section {
        LabeledContent("Status") {
          HStack(spacing: 6) {
            McpStatusDot(status: server.status)
            Text(server.status)
          }
        }
        if let error = server.error {
          LabeledContent("Error", value: error)
            .foregroundStyle(.red)
        }
        if let transport = server.transport {
          LabeledContent("Transport", value: transport)
        }
        if let command = server.command {
          LabeledContent("Command", value: command)
        }
        if let args = server.args, !args.isEmpty {
          LabeledContent("Args", value: args.joined(separator: " "))
        }
        if let url = server.url {
          LabeledContent("URL", value: url)
        }
        if let scope = server.scope {
          LabeledContent("Scope", value: scope)
        }
        if let info = server.serverInfo {
          LabeledContent("Version", value: "\(info.name) \(info.version)")
        }
      }

      if server.isConnected {
        Section {
          NavigationLink {
            McpToolsView(serverName: server.name, tools: server.tools ?? [])
          } label: {
            LabeledContent("Tools", value: "\(server.toolCount)")
          }
        }
      }

      // Absent, not disabled, when the engine has no per-server action: a
      // greyed-out Reconnect invites "why can't I?" on every visit, where
      // nothing at all reads as "this engine works differently".
      if canManage {
        Section {
          actionButton("Reconnect", "arrow.clockwise", .reconnect)
          if server.isDisabled {
            actionButton("Enable", "power", .enable)
          } else {
            actionButton("Disable", "power", .disable)
          }
        } footer: {
          // The CLI's own caveat, and the reason a disable is not destructive:
          // it is this session's view of the server, not an edit to a config file.
          Text("Applies to this session only — your .mcp.json is untouched.")
        }
      }
    }
    .navigationTitle(server.name)
    .navigationBarTitleDisplayMode(.inline)
  }

  private func actionButton(
    _ title: String, _ symbol: String, _ action: McpServerActionRequest.Action
  ) -> some View {
    Button {
      inFlight = action
      Task {
        await act(server.name, action)
        inFlight = nil
      }
    } label: {
      HStack {
        Label(title, systemImage: symbol)
        Spacer(minLength: 8)
        if inFlight == action { ProgressView().controlSize(.mini) }
      }
    }
    .disabled(inFlight != nil)
  }
}

/// A server's tools. Searchable because 85 of them is a normal number.
private struct McpToolsView: View {
  let serverName: String
  let tools: [McpServerToolInfo]

  @State private var query = ""

  var body: some View {
    List(filtered) { tool in
      NavigationLink {
        McpToolDetailView(serverName: serverName, tool: tool)
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(tool.name)
            .font(.body.monospaced())
          if let description = tool.description, !description.isEmpty {
            Text(description)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
        }
      }
    }
    .searchable(text: $query, prompt: "Filter tools")
    .navigationTitle("\(tools.count) tool\(tools.count == 1 ? "" : "s")")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var filtered: [McpServerToolInfo] {
    let trimmed = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !trimmed.isEmpty else { return tools }
    return tools.filter {
      $0.name.lowercased().contains(trimmed)
        || ($0.description ?? "").lowercased().contains(trimmed)
    }
  }
}

/// One tool. The full name matters most: it is what an `allowedTools` entry or a
/// permission rule has to spell exactly.
private struct McpToolDetailView: View {
  let serverName: String
  let tool: McpServerToolInfo

  var body: some View {
    List {
      Section {
        LabeledContent("Tool name", value: tool.name)
        LabeledContent("Full name", value: "mcp__\(serverName)__\(tool.name)")
        LabeledContent("Server", value: serverName)
      }
      if let description = tool.description, !description.isEmpty {
        Section("Description") {
          Text(description)
            .font(.callout)
        }
      }
      if let annotations = tool.annotations, annotations.readOnly != nil
        || annotations.destructive != nil || annotations.openWorld != nil
      {
        Section("Behaviour") {
          if let readOnly = annotations.readOnly {
            LabeledContent("Read only", value: readOnly ? "yes" : "no")
          }
          if let destructive = annotations.destructive {
            LabeledContent("Destructive", value: destructive ? "yes" : "no")
          }
          if let openWorld = annotations.openWorld {
            LabeledContent("Open world", value: openWorld ? "yes" : "no")
          }
        }
      }
      // Engine-dependent, and said as such: codex returns each tool's full JSON
      // Schema, the Agent SDK returns none. A real section where one exists, an
      // explanation where it doesn't — never a silent gap.
      if let schema = tool.inputSchema {
        Section("Parameters") {
          Text(schema.prettyJSON)
            .font(.caption.monospaced())
            .textSelection(.enabled)
        }
      } else {
        Section {
          Text("Parameters are not reported by this engine — its status payload names and describes each tool but carries no input schema.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .navigationTitle(tool.name)
    .navigationBarTitleDisplayMode(.inline)
  }
}
