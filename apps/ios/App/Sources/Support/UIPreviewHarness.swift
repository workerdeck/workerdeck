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
  case markdown
  case terminal
  case terminalStress

  static var active: UIPreview? {
    ProcessInfo.processInfo.environment["UIPREVIEW"].flatMap(UIPreview.init(rawValue:))
  }
}

/// The terminal transcript with its overflow gate reported on screen.
///
/// The audit is the one thing that can catch a cell model disagreeing with real
/// text layout, and it is worthless unless somebody looks at it — so the preview
/// that exists for looking at things shows it.
private struct TerminalAuditPreview: View {
  let items: [TranscriptItem]
  @State private var verdict = "auditing…"

  var body: some View {
    VStack(spacing: 0) {
      Text(verdict)
        .font(.caption.monospaced())
        .foregroundStyle(verdict.hasPrefix("✔") ? Color.green : Color.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color.black)
      TerminalTranscriptView(
        items: items, revision: 0, scroll: TranscriptScrollModel(),
        onAudit: { verdict = $0.summary })
    }
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

  /// Canned transcript for the `terminal` preview. Shaped to exercise the folds
  /// rather than to look plausible — a fixture where every tool call is adjacent
  /// and every subagent tidy would pass whatever the row model did.
  static let terminalItems: [TranscriptItem] = {
    func call(
      _ id: String, _ name: String, _ input: [String: JSONValue],
      parent: String? = nil, status: ToolCallStatus = .settled, result: String? = nil,
      isError: Bool = false, patch: FilePatch? = nil
    ) -> TranscriptItem {
      .toolCall(
        ToolCallItem(
          id: id, name: name, input: .object(input), parentToolUseId: parent, status: status,
          result: result.map { ToolCallResult(text: $0, isError: isError) }, patch: patch))
    }

    return [
      .user(
        id: "u1",
        text: "Port the terminal theme to the phone — virtualized, deterministic heights, the lot.",
        attachments: nil, parentToolUseId: nil),
      .thinking(
        id: "th1",
        text:
          "The heights are the hard part. If the planner wraps and the renderer draws those lines, there is nothing left to predict.",
        parentToolUseId: nil),
      .assistantText(
        id: "a1",
        text: """
          I'll start by mapping both sides. Two things decide the shape:

          - **the fold** — a run of calls is one row, a `Task` is one row
          - **the cell** — one measured advance, one whole-point line

          Then `height.ts` becomes a *planner* rather than a predictor.
          """,
        streaming: false, parentToolUseId: nil),
      // A run: three consecutive calls, one of which failed. A failure colours
      // the run, it does not split it.
      call("c1", "Bash", ["command": .string("swift build")], result: "Build complete! (0.72s)"),
      call("c2", "Grep", ["pattern": .string("isLines")], result: "", isError: true),
      call("c3", "Read", ["file_path": .string("/src/height.ts")], result: "740 lines"),
      // A Task whose children interleave with a second Task's — the case an
      // adjacency rule gets wrong.
      call("t1", "Task", ["subagent_type": .string("Explore"), "description": .string("map the web theme")], status: .running),
      call("t2", "Task", ["subagent_type": .string("Plan"), "description": .string("size the port")]),
      call("k1", "Glob", ["pattern": .string("**/*.tsx")], parent: "t1", result: "17 files"),
      call("k2", "Read", ["file_path": .string("/plan.md")], parent: "t2", result: "ok"),
      call("k3", "Bash", ["command": .string("wc -l")], parent: "t1", status: .running),
      .assistantText(
        id: "a15", text: "Checking what the fold does to a minified reply.", streaming: false,
        parentToolUseId: nil),
      // Both preview budgets: a minified blob (one line, thirty thousand chars)
      // is the case a line-only budget silently kept whole. Deliberately NOT
      // adjacent to another call — a folded run would collapse the very preview
      // this fixture exists to show.
      call(
        "c4", "mcp__roam_code__search", ["query": .string("terminalBlocks")],
        result: "{\"hits\":[" + String(repeating: "{\"f\":\"blocks.ts\",\"l\":42},", count: 400) + "]}"),
      .assistantText(
        id: "a16", text: "And the diff, with the engine's own line numbers.", streaming: false,
        parentToolUseId: nil),
      call(
        "c5", "Edit", ["file_path": .string("/apps/ios/App/Sources/Session/Terminal/TerminalRowViews.swift")],
        result: "ok",
        patch: FilePatch(
          path: "/apps/ios/App/Sources/Session/Terminal/TerminalRowViews.swift", kind: "update",
          hunks: [
            PatchHunk(
              oldStart: 96, oldLines: 4, newStart: 96, newLines: 5,
              lines: [
                "     .lineLimit(1)",
                "-    .fixedSize()",
                "+    .fixedSize(horizontal: false, vertical: true)",
                "+    .frame(height: metrics.line, alignment: .topLeading)",
                "     .clipped()",
              ])
          ])),
      .assistantText(
        id: "a2",
        text: "Heights are exact by construction now — the planner wraps, the row draws what it returned.",
        streaming: false, parentToolUseId: nil),
      .turnResult(
        id: "tr1", subtype: "success", isError: false, durationMs: 94_300,
        totalCostUsd: 1.87, errors: nil),
    ]
  }()

  /// The stress fixture: the same handful of shapes, repeated until the row
  /// count is one no view hierarchy could hold.
  static let terminalStressItems: [TranscriptItem] = {
    var items: [TranscriptItem] = []
    for turn in 0..<4_000 {
      items.append(
        .user(id: "u\(turn)", text: "Turn \(turn): what changed?", attachments: nil,
          parentToolUseId: nil))
      items.append(
        .assistantText(
          id: "a\(turn)",
          text: "Answer \(turn). The planner wrapped this line, and the row drew what it returned.",
          streaming: false, parentToolUseId: nil))
      items.append(
        .toolCall(
          ToolCallItem(
            id: "s\(turn)a", name: "Bash", input: .object(["command": .string("git log -1")]),
            status: .settled, result: ToolCallResult(text: "commit \(turn)", isError: false))))
      items.append(
        .toolCall(
          ToolCallItem(
            id: "s\(turn)b", name: "Read", input: .object(["file_path": .string("/f\(turn).ts")]),
            status: .settled, result: ToolCallResult(text: "ok", isError: false))))
      items.append(
        .turnResult(
          id: "tr\(turn)", subtype: "success", isError: false, durationMs: 1_200,
          totalCostUsd: 0.01, errors: nil))
    }
    return items
  }()

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
                availableHeight: height)
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
    case .terminalStress:
      // The claim this whole engine exists for: a transcript far longer than
      // anything a scroll view can hold as views. 4,000 turns is ~20,000 rows
      // and well past what the old LazyVStack could survive.
      TerminalAuditPreview(items: Self.terminalStressItems)

    case .terminal:
      // The four things the terminal theme's row model can get wrong, on one
      // screen: a folded run of consecutive calls, a `Task` that absorbed
      // children arriving out of order, a diff carrying the engine's own line
      // numbers, and a tool result long enough to hit both preview budgets.
      TerminalAuditPreview(items: Self.terminalItems)

    case .markdown:
      // Every block type on one screen, plus the two streaming frontiers that
      // matter (an open fence, a bare bullet) — the shapes a turn passes
      // through while the model is still typing.
      ScrollView {
        MarkdownText(
          text: """
            ## Block rendering

            Plain prose with **bold**, `a span`, and a [link](https://example.com), \
            plus an @file token and a /command one.

            ### The plan

            1. Read `MarkdownBlocks.swift`
            2. Extend the parser
               - keep fences working
               - keep prose as the fallback
            3. Render it

            > Streaming is the design constraint — a block must render in its
            > final shape from its first character.

            ---

            | a | b |
            |---|---|
            | tables | stay literal |

            ```swift
            let x = 1
            ```

            - a bullet still arriving:
            -
            ```ts
            const streaming = true
            """)
          .padding()
      }
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
