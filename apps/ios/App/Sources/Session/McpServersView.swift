import Observation
import SwiftUI
import WorkerDeckCore

// The `/mcp` screens as a navigation stack (servers, one server, its tools, one tool), Claude Code's own `/mcp`
// picker. The core's `McpServers` holds the last answer and says what every level shows; an action answers with the
// refreshed list, so one call updates the whole stack (a refused one refetches it).
@MainActor
@Observable
final class McpServersModel {
  private(set) var revision = 0
  private let servers: McpServers
  private let transport: HostTransport

  init(servers: McpServers, transport: @escaping HostTransport) {
    self.servers = servers
    self.transport = transport
  }

  var loading: Bool { read { servers.loading() } }
  var error: String? { read { servers.error() } }
  var isEmpty: Bool { read { servers.isEmpty() } }
  var sections: [McpSection] { read { servers.sections() } }

  func server(_ name: String) -> McpServerDetail? { read { servers.server(name: name) } }
  func toolsTitle(_ server: String) -> String { read { servers.toolsTitle(server: server) } }
  func tools(_ server: String, _ query: String) -> [McpToolRow] { read { servers.tools(server: server, query: query) } }
  func tool(_ server: String, _ tool: String) -> McpToolDetail? { read { servers.tool(server: server, tool: tool) } }

  func refresh() async {
    let call = servers.refreshCall()
    revision &+= 1
    servers.answered(answer: await transport(call))
    revision &+= 1
  }

  func perform(_ name: String, _ action: McpAction) async {
    if let refetch = servers.actionAnswered(answer: await transport(servers.actionCall(server: name, action: action))) {
      servers.answered(answer: await transport(refetch))
    }
    revision &+= 1
  }

  private func read<T>(_ body: () -> T) -> T {
    _ = revision
    return body()
  }
}

struct McpServersView: View {
  let model: McpServersModel

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        if model.loading {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.isEmpty {
          ContentUnavailableView {
            Label("No MCP servers", systemImage: "puzzlepiece.extension")
          } description: {
            Text(model.error ?? "This session has no MCP servers configured.")
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
      .task { await model.refresh() }
      .refreshable { await model.refresh() }
    }
  }

  private var list: some View {
    List {
      ForEach(model.sections, id: \.scope) { section in
        Section(section.title) {
          ForEach(section.servers, id: \.name) { server in
            NavigationLink {
              McpServerDetailView(model: model, name: server.name)
            } label: {
              McpServerRowView(server: server)
            }
          }
        }
      }
    }
    .listStyle(.insetGrouped)
    .overlay(alignment: .bottom) {
      if let error = model.error {
        Text(error)
          .font(.caption)
          .foregroundStyle(.orange)
          .padding(10)
          .frame(maxWidth: .infinity)
          .background(.regularMaterial)
      }
    }
  }
}

private struct McpServerRowView: View {
  let server: McpServerRow

  var body: some View {
    HStack(spacing: 10) {
      McpStatusDot(status: server.status, tint: server.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(server.name)
          .font(.body.monospaced())
          .lineLimit(1)
          .truncationMode(.middle)
        HStack(spacing: 4) {
          Text(server.status)
          if let tools = server.tools {
            Text("·")
            Text(tools)
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
  }
}

struct McpStatusDot: View {
  let status: String
  let tint: McpStatus

  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 8, height: 8)
      .accessibilityLabel(status)
  }

  private var color: Color {
    switch tint {
    case .connected: .green
    case .failed: .red
    case .needsAuth: .orange
    case .pending: .yellow
    case .other: .secondary
    }
  }
}

private struct McpServerDetailView: View {
  let model: McpServersModel
  let name: String

  @State private var inFlight: McpAction?

  var body: some View {
    List {
      if let server = model.server(name) {
        Section {
          LabeledContent("Status") {
            HStack(spacing: 6) {
              McpStatusDot(status: server.status, tint: server.tint)
              Text(server.status)
            }
          }
          ForEach(server.facts, id: \.label) { fact in
            LabeledContent(fact.label, value: fact.value)
              .foregroundStyle(fact.alert ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
          }
        }
        if let count = server.toolCount {
          Section {
            NavigationLink {
              McpToolsView(model: model, server: name)
            } label: {
              LabeledContent("Tools", value: "\(count)")
            }
          }
        }
        if !server.actions.isEmpty {
          Section {
            ForEach(server.actions, id: \.self) { action in
              actionButton(action)
            }
          } footer: {
            VStack(alignment: .leading, spacing: 6) {
              if let error = model.error { Text(error).foregroundStyle(.orange) }
              Text("Applies to this session only - your .mcp.json is untouched.")
            }
          }
        }
      }
    }
    .navigationTitle(name)
    .navigationBarTitleDisplayMode(.inline)
  }

  private func actionButton(_ action: McpAction) -> some View {
    let (title, symbol) =
      switch action {
      case .reconnect: ("Reconnect", "arrow.clockwise")
      case .enable: ("Enable", "power")
      case .disable: ("Disable", "power")
      }
    return Button {
      inFlight = action
      Task {
        await model.perform(name, action)
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

private struct McpToolsView: View {
  let model: McpServersModel
  let server: String

  @State private var query = ""

  var body: some View {
    List(model.tools(server, query), id: \.name) { tool in
      NavigationLink {
        McpToolDetailView(model: model, server: server, name: tool.name)
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(tool.name)
            .font(.body.monospaced())
          if let title = tool.title {
            Text(title)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          if let description = tool.description {
            Text(description)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)
          }
        }
      }
    }
    .searchable(text: $query, prompt: "Filter tools")
    .navigationTitle(model.toolsTitle(server))
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct McpToolDetailView: View {
  let model: McpServersModel
  let server: String
  let name: String

  var body: some View {
    List {
      if let tool = model.tool(server, name) {
        Section {
          ForEach(tool.facts, id: \.label) { LabeledContent($0.label, value: $0.value) }
        }
        if let description = tool.description {
          Section("Description") {
            Text(description)
              .font(.callout)
          }
        }
        if !tool.behaviour.isEmpty {
          Section("Behaviour") {
            ForEach(tool.behaviour, id: \.label) { LabeledContent($0.label, value: $0.value) }
          }
        }
        if let parameters = tool.parameters {
          Section("Parameters") {
            Text(parameters)
              .font(.caption.monospaced())
              .textSelection(.enabled)
          }
        } else {
          Section {
            Text(
              "Parameters are not reported by this engine - its status payload names and describes each tool but carries no input schema."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }
        }
      }
    }
    .navigationTitle(name)
    .navigationBarTitleDisplayMode(.inline)
  }
}
