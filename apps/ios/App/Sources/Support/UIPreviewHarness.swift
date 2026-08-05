import WorkerDeckKit
import SwiftUI

/// A screen of the app, rendered from canned data with no gateway behind it.
///
/// This exists for the build-and-look loop: most of the interesting screens only
/// appear once a live session is running against a real server with a real
/// subscription, which makes "did that layout come out right" an expensive
/// question. Launching a simulator with `UIPREVIEW=<variant>` set answers it in
/// one build.
///
/// ```sh
/// xcrun simctl launch --terminate-running-process booted bi.atomic.workerdeck.ios \
///   ; SIMCTL_CHILD_UIPREVIEW=usage xcrun simctl launch booted bi.atomic.workerdeck.ios
/// xcrun simctl io booted screenshot /tmp/usage.png
/// ```
///
/// It is inert without the variable, so it costs the shipped app one `if`. Add a
/// case when a screen is hard to reach; the canned data is meant to be edited.
enum UIPreview: String {
  case usage
  case context
  case folders
  case statusbar
  case modelPicker
  case modePicker
  case empty
  case addMedia
  case mcp

  static var active: UIPreview? {
    ProcessInfo.processInfo.environment["UIPREVIEW"].flatMap(UIPreview.init(rawValue:))
  }
}

struct UIPreviewHarness: View {
  let variant: UIPreview
  /// Editing a fixture and watching it land is the whole point of this screen.
  @HotReloaded private var hot

  /// Exactly what a live gateway sends, copied off the wire — alias values, the
  /// CLI's own short display names, and the version in the description. Plus one
  /// non-primary row, which this CLI doesn't currently report but the picker has
  /// to be able to group.
  static let models = [
    ModelOption(
      value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)",
      description: "Opus 5 with 1M context · Best for everyday, complex tasks", primary: true),
    ModelOption(
      value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable",
      description: "Fable 5 · Most capable for your hardest and longest-running tasks",
      primary: true),
    ModelOption(
      value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks", primary: true),
    ModelOption(
      value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers", primary: true),
    ModelOption(
      value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8",
      description: "The previous Opus", primary: false),
  ]

  static let mcpServers: [McpServerStatusInfo] = [
    McpServerStatusInfo(
      name: "chrome-devtools", status: "connected", scope: "project", error: nil,
      serverInfo: .init(name: "chrome-devtools", version: "0.6.1"), transport: "stdio",
      command: "npx", args: ["chrome-devtools-mcp@latest", "--isolated"], url: nil,
      tools: [
        McpServerToolInfo(
          name: "click", description: "Clicks on the provided element", annotations: nil),
        McpServerToolInfo(name: "close_page", description: "Closes a page", annotations: nil),
        McpServerToolInfo(
          name: "evaluate_script", description: "Evaluates a script in the page",
          annotations: .init(readOnly: false, destructive: true, openWorld: nil)),
      ]),
    McpServerStatusInfo(
      name: "roam-code", status: "connected", scope: "user", error: nil, serverInfo: nil,
      transport: "stdio", command: "roam-code", args: ["mcp"], url: nil,
      tools: [McpServerToolInfo(name: "roam_ask", description: nil, annotations: nil)]),
    McpServerStatusInfo(
      name: "deepwiki", status: "failed", scope: "user", error: "connection refused",
      serverInfo: nil, transport: "http", command: nil, args: nil,
      url: "https://mcp.deepwiki.com/mcp", tools: nil),
    McpServerStatusInfo(
      name: "computer-use", status: "disabled", scope: nil, error: nil, serverInfo: nil,
      transport: nil, command: nil, args: nil, url: nil, tools: nil),
  ]

  var body: some View {
    switch variant {
    case .usage:
      UsageSheet(
        rateLimits: [
          (
            key: "five_hour",
            info: RateLimitInfo(
              status: "allowed", rateLimitType: "five_hour", utilization: 6,
              resetsAt: Date().timeIntervalSince1970 + 2 * 3600 + 57 * 60)
          ),
          (
            key: "seven_day",
            info: RateLimitInfo(
              status: "allowed", rateLimitType: "seven_day", utilization: 17,
              resetsAt: Date().timeIntervalSince1970 + 4 * 86_400 + 3 * 3600)
          ),
          (
            key: "seven_day_fable",
            info: RateLimitInfo(
              status: "allowed", rateLimitType: "seven_day_fable", utilization: 92,
              resetsAt: Date().timeIntervalSince1970 + 4 * 86_400 + 3 * 3600)
          ),
        ],
        subscriptionType: "max",
        engine: .claude,
        totalCostUsd: 1.2345,
        updatedAt: Date().addingTimeInterval(-8))
    case .context:
      ContextSheet(
        usage: ContextUsage(
          categories: [
            ContextUsageCategory(name: "System prompt", tokens: 3_200, color: "#8b5cf6"),
            ContextUsageCategory(name: "Tools", tokens: 12_800, color: "#22c55e"),
            ContextUsageCategory(name: "Messages", tokens: 41_000, color: "#3b82f6"),
          ],
          totalTokens: 57_000, maxTokens: 200_000, percentage: 28.5, model: "claude-opus-5"))
    case .statusbar:
      VStack {
        Spacer()
        SessionStatusBar(
          status: .running,
          pendingCount: 0,
          connection: .live,
          contextUsage: ContextUsage(
            categories: [], totalTokens: 57_000, maxTokens: 200_000, percentage: 28.5),
          rateLimits: [
            (key: "five_hour", info: RateLimitInfo(status: "allowed", utilization: 6)),
            (key: "seven_day", info: RateLimitInfo(status: "allowed", utilization: 17)),
            (key: "seven_day_fable", info: RateLimitInfo(status: "allowed", utilization: 92)),
          ],
          totalCostUsd: 1.23,
          model: "claude-opus-5[1m]",
          models: Self.models,
          permissionMode: .acceptEdits,
          onOpenModel: {},
          onOpenMode: {},
          onOpenContext: {},
          onOpenUsage: {},
          onOpenInfo: {})
          .padding(.horizontal, 12)
        Spacer()
      }
    case .modelPicker:
      ModelPickerSheet(
        models: Self.models, current: "claude-opus-5[1m]", defaultModel: "claude-sonnet-5",
        onSelect: { _ in })
    case .modePicker:
      ModePickerSheet(
        modes: [.default, .acceptEdits, .plan, .auto, .bypassPermissions, .dontAsk],
        current: .acceptEdits, defaultMode: .default, canBypass: false, onSelect: { _ in })
    case .empty:
      // Every density at once — what this screen does as the space runs out is
      // the whole reason it has more than one form.
      ScrollView {
        VStack(spacing: 26) {
          ForEach([700.0, 300.0, 220.0, 120.0], id: \.self) { height in
            VStack(spacing: 6) {
              Text("offered \(Int(height))pt")
                .font(.caption2)
                .foregroundStyle(.tertiary)
              SessionEmptyState(
                cwd: "/Users/you/projects/workerdeck", hasCommands: true, canBrowseFiles: true,
                resumedWithoutHistory: height == 700, availableHeight: height)
            }
          }
        }
        .padding(.vertical, 60)
      }
    case .addMedia:
      // Presented over something, because a detent sheet has no shape on its own.
      Color.black.sheet(isPresented: .constant(true)) {
        AddMediaSheet(acceptsImages: true, onChoose: { _ in })
      }
    case .mcp:
      // A shape copied off a real `/mcp`: two scopes, a healthy stdio server, a
      // failed remote one, and one the session has disabled.
      McpServersView(
        load: { Self.mcpServers },
        act: { _, _ in Self.mcpServers })
    case .folders:
      let root = "/Users/you/projects"
      FolderPickerView(
        // Never contacted: the seeded model already has every answer the screen
        // asks for, and both fetches short-circuit on what they find.
        client: WorkerClient(baseURL: URL(string: "http://127.0.0.1:1")!),
        onSelect: { _ in },
        seeded: FolderPickerModel(
          client: WorkerClient(baseURL: URL(string: "http://127.0.0.1:1")!),
          roots: [HostFileRoot(path: root, name: "projects")],
          listings: [
            root: [
              HostDirEntry(name: "workerdeck", path: "\(root)/workerdeck", type: .dir),
              HostDirEntry(name: "silkweave", path: "\(root)/silkweave", type: .dir),
              HostDirEntry(name: "gtm", path: "\(root)/gtm", type: .dir),
              HostDirEntry(name: "scratch", path: "\(root)/scratch", type: .symlink),
            ]
          ]))
    }
  }
}
