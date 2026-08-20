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
  case composer
  case prompts
  case terminal
  case terminalOpen
  case terminalStress
  case projects

  static var active: UIPreview? {
    ProcessInfo.processInfo.environment["UIPREVIEW"].flatMap(UIPreview.init(rawValue:))
  }
}

/// The sessions list's second line, in every project state it has.
///
/// The claim being checked is not "does this look right" but **"does each rule
/// actually fire"** — the project replacing a path, the relative half appearing
/// and disappearing, a glyph this build cannot map falling back to a folder
/// rather than a hole, and an SVG (which Apple cannot decode from bytes at all)
/// degrading to the name rather than to a gap. Every one of those needs a
/// differently-configured gateway to produce for real, which is exactly what
/// this harness is for.
private struct ProjectsPreview: View {
  private static func session(
    id: String, title: String, cwd: String, project: ProjectInfo? = nil
  ) -> SessionInfo {
    SessionInfo(
      id: id, status: .idle, cwd: cwd, engine: .claude, model: "claude-opus-5",
      createdAt: 0, lastSeq: 0, pendingPermissionCount: 0, title: title,
      // A plausible age: `lastActivityAt` is epoch **ms**, and a fixture that
      // reads "20684d" is a fixture nobody trusts the rest of.
      lastActivityAt: Date().timeIntervalSince1970 * 1000 - 15 * 60 * 1000,
      project: project)
  }

  /// A red square, so "the bytes arrived" is unmistakable against "they did not".
  private static var pngBytes: UIImage? {
    UIGraphicsImageRenderer(size: .init(width: 32, height: 32)).image { ctx in
      UIColor.systemIndigo.setFill()
      ctx.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
    }
  }

  private struct Case: Identifiable {
    let id = UUID()
    let caption: String
    let session: SessionInfo
    var image: UIImage?
  }

  private var cases: [Case] {
    let wd = ProjectInfo(
      name: "WorkerDeck", root: "/Users/you/projects/workerdeck",
      icon: .image(mediaType: .png, hash: "abc"))
    return [
      Case(
        caption: "image icon, bytes in, session at the project root",
        session: Self.session(
          id: "1", title: "Terminal fold audit", cwd: "/Users/you/projects/workerdeck",
          project: wd),
        image: Self.pngBytes),
      Case(
        caption: "…and deeper in: the relative half earns its place",
        session: Self.session(
          id: "2", title: "Scrubber lanes",
          cwd: "/Users/you/projects/workerdeck/packages/ui", project: wd),
        image: Self.pngBytes),
      Case(
        caption: "bytes not in yet — no hole, no placeholder box",
        session: Self.session(
          id: "3", title: "Waiting on its icon",
          cwd: "/Users/you/projects/workerdeck/packages/web", project: wd)),
      Case(
        caption: "SVG: Apple cannot decode one from bytes, so it reads as no icon",
        session: Self.session(
          id: "4", title: "The platform limit", cwd: "/Users/you/projects/deck",
          project: ProjectInfo(
            name: "Deck", root: "/Users/you/projects/deck",
            icon: .image(mediaType: .svg, hash: "svg")))),
      Case(
        caption: "glyph this build maps (tree-pine → tree)",
        session: Self.session(
          id: "5", title: "Theme rework", cwd: "/Users/you/projects/silktree/app",
          project: ProjectInfo(
            name: "Silktree", root: "/Users/you/projects/silktree",
            icon: .glyph(name: "tree-pine")))),
      Case(
        caption: "well-formed glyph this build has never heard of → folder, not a hole",
        session: Self.session(
          id: "6", title: "Grid layout", cwd: "/Users/you/projects/zigby",
          project: ProjectInfo(
            name: "Zigby", root: "/Users/you/projects/zigby",
            icon: .glyph(name: "some-icon-shipped-last-tuesday")))),
      Case(
        caption: "cwd NOT under root (a symlinked start) — name alone, never a wrong path",
        session: Self.session(
          id: "7", title: "Through a symlink", cwd: "/tmp/deck-link/packages/ui",
          project: ProjectInfo(name: "WorkerDeck", root: "/private/tmp/deck", icon: nil))),
      Case(
        caption: "no .workerdeck.json anywhere above it — the raw cwd, exactly as before",
        session: Self.session(
          id: "8", title: "Launch preparation",
          cwd: "/Users/you/projects/atomic/services/gtm")),
    ]
  }

  var body: some View {
    NavigationStack {
      List {
        ForEach(cases) { item in
          VStack(alignment: .leading, spacing: 2) {
            Text(item.caption).font(.caption2).foregroundStyle(.tertiary)
            SessionRowView(session: item.session, unseen: 0, projectImage: item.image)
          }
        }
      }
      .navigationTitle("Project line")
    }
  }
}

/// The docked (terminal) composer in each of its gutter states.
///
/// Stacked rather than switched, because the claim being checked is an
/// *alignment* one: `\u{276F}`, `+` and `\u{2715}` occupy the same cell, and the typed line
/// must start on the same column whichever of them is standing. A screenshot of
/// one state cannot show that; a column of them can.
private struct ComposerPreview: View {
  private struct Row: View {
    let caption: String
    let busy: Bool
    let canAddMedia: Bool
    let draft: String
    @State private var text: String
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var focused = false

    init(caption: String, busy: Bool, canAddMedia: Bool, draft: String) {
      self.caption = caption
      self.busy = busy
      self.canAddMedia = canAddMedia
      self.draft = draft
      _text = State(initialValue: draft)
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 2) {
        Text(caption).font(.caption2).foregroundStyle(.tertiary).padding(.leading, 8)
        ComposerView(
          text: $text, selection: $selection, isFocused: $focused, isBusy: busy,
          isEnabled: true, attachments: ComposerAttachmentStore(), canAddMedia: canAddMedia,
          onEdit: { t, r in text = t; selection = r }, onSend: {}, onStop: {}, onAddMedia: {})
      }
    }
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 22) {
        Row(caption: "idle, nothing to attach - the column falls back to the prompt glyph",
          busy: false, canAddMedia: false, draft: "")
        Row(caption: "idle, attachments available", busy: false, canAddMedia: true, draft: "")
        Row(caption: "draft - send is armed", busy: false, canAddMedia: true, draft: "explain the fold")
        Row(caption: "working - stop takes the gutter, send keeps its slot",
          busy: true, canAddMedia: true, draft: "")
        Row(caption: "working WITH a draft - the bug the web fixed: stop must still be reachable",
          busy: true, canAddMedia: true, draft: "and then run the tests")
      }
      .padding(.vertical, 24)
    }
    .environment(\.transcriptVariant, .terminal)
  }
}

/// The terminal transcript with its overflow gate reported on screen.
///
/// The audit is the one thing that can catch a cell model disagreeing with real
/// text layout, and it is worthless unless somebody looks at it — so the preview
/// that exists for looking at things shows it.
private struct TerminalAuditPreview: View {
  let items: [TranscriptItem]
  /// Open every block on mount. The audit checks the expanded plan
  /// arithmetically either way; this is what puts it through a real layout
  /// pass, which is the only thing that can show a planned line and a drawn
  /// line parting company.
  var expandAll = false
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
      // `onAudit`/`expandAll` are `#if DEBUG` on the view — the audit is a dev
      // gate, not shipped surface — so the Release build has to construct it
      // without them. `deploy.sh --release` is what found this: nothing had
      // ever compiled this file optimized.
      #if DEBUG
        TerminalTranscriptView(
          items: items, revision: 0, scroll: TranscriptScrollModel(),
          onAudit: { verdict = $0.summary }, expandAll: expandAll)
      #else
        TerminalTranscriptView(items: items, revision: 0, scroll: TranscriptScrollModel())
      #endif
    }
  }
}

/// The prompts, at a height that forces them to scroll.
///
/// The claim under test is not "does this look right" but "can it be answered":
/// before this, a prompt taller than the screen pushed its own buttons past the
/// bottom edge and the only way out was to kill the app. So every row here is
/// deliberately over-long, and the thing to check in a screenshot is that the
/// action row is on screen in all of them.
/// The prompts, at a height that forces them to scroll.
///
/// The claim under test is not "does this look right" but **"can it be
/// answered"**: before the cap, a prompt taller than the screen pushed its own
/// buttons past the bottom edge and there was no way to reach them. So the rows
/// here are deliberately over-long and the caps deliberately mean, and the thing
/// to check in a screenshot is that the action row is visible in both.
private struct PromptsPreview: View {
  /// Built as the wire shape and parsed back through `parseUserQuestions`,
  /// rather than as Swift values: `UserQuestion` is `Decodable` with no public
  /// memberwise init, and going through the real parser means the fixture is
  /// exercising the same path a live request does.
  private static let questionInput: JSONValue = .object([
    "questions": .array([
      .object([
        "question": .string(
          "The truncation rule shipped on a 68% projection and measured 0.3% on the wire. What do you want to do about the other six rules in the family?"),
        "header": .string("Verification"),
        "options": .array([
          .object([
            "label": .string("Measure all six before the next bump"),
            "description": .string(
              "Re-run the attach measurement against a real session for each rule and record what it actually cut, not what it was projected to cut. Slow, and the only thing that retires the warning."),
            "preview": .string("replayRetains    774 KB -> ?\nsnapshotRetains        ?\nreplayCoalesceKey 388 KB -> ?"),
          ]),
          .object([
            "label": .string("Measure only the ones that ship bytes"),
            "description": .string(
              "The three that change what crosses the wire. The store-side rules can wait, since a wrong answer there costs disk rather than a reader's network."),
          ]),
          .object([
            "label": .string("Leave it and keep the warning standing"),
            "description": .string(
              "The warning is honest as it is and each measurement costs a session. Nothing is claimed that has not been measured, because the claims are what would change."),
          ]),
        ]),
      ])
    ])
  ])

  private static func request(
    id: String, tool: String, title: String, input: JSONValue
  ) -> PermissionRequest {
    PermissionRequest(id: id, toolName: tool, input: input, toolUseId: "toolu_\(id)", title: title)
  }

  private static var questionRequest: PermissionRequest {
    request(
      id: "q", tool: "AskUserQuestion", title: "The agent has a question", input: questionInput)
  }

  private static var permissionRequest: PermissionRequest {
    request(
      id: "p", tool: "Bash", title: "Run this command?",
      input: .object([
        "command": .string(
          "pnpm smoke:attach 127.0.0.1:8787 01JQ8Z3K4M5N6P7Q8R9S0T1U2V truncate refs | tee /tmp/attach-parts-$(date +%Y%m%d).txt")
      ]))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        caption("Question — three long options, body capped at 260")
        TerminalQuestionPromptView(
          request: Self.questionRequest,
          questions: parseUserQuestions(Self.questionRequest),
          maxBodyHeight: 260,
          onAnswer: { _ in }, onDismiss: {})

        caption("Permission — a command worth reading whole, body capped at 200")
        TerminalPermissionPromptView(
          request: Self.permissionRequest,
          maxBodyHeight: 200,
          onAllow: {}, onDeny: { _, _ in })
      }
      .padding(.vertical, 16)
    }
  }

  private func caption(_ text: String) -> some View {
    Text(text).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 16)
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
    case .prompts:
      // The two terminal prompts against the case that broke them: a question
      // with three long options and a permission whose subject is a Bash command
      // nobody would want clipped. Both are given a deliberately mean
      // `maxBodyHeight` so the scroll is exercised on a big simulator too —
      // what must be true on screen is that the action row is visible in every
      // one of them, which is the entire bug.
      PromptsPreview()

    case .projects:
      // Every shape line two can take, because each one is a different rule and
      // most need a differently-configured gateway to reach for real.
      ProjectsPreview()

    case .composer:
      // Every state the gutter cell has, stacked, because the whole point of
      // that cell is that its three occupants must not move the text beside
      // them — and the only way to see that is to see them above one another.
      ComposerPreview()
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

    case .terminalOpen:
      // The same fixture with every block open. Expansion is the one thing this
      // renderer has to *predict* that the web client never does — there, an
      // expanded row is mounted and the browser measures it — so it needs the
      // same treatment the collapsed plan gets: real text, real layout, and the
      // audit reading out on top.
      TerminalAuditPreview(items: Self.terminalItems, expandAll: true)

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
