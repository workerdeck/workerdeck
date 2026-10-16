import SwiftUI
import WorkerDeckCore
import WorkerDeckKit

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
///   ; SIMCTL_CHILD_UIPREVIEW=sessions xcrun simctl launch booted bi.atomic.workerdeck.ios
/// xcrun simctl io booted screenshot /tmp/sessions.png
/// ```
///
/// It is inert without the variable, so it costs the shipped app one `if`. Add a
/// case when a screen is hard to reach; the canned data is meant to be edited.
enum UIPreview: String {
  case folders
  case steps
  case projects
  case sessions
  case teams
  case core

  static var active: UIPreview? {
    ProcessInfo.processInfo.environment["UIPREVIEW"].flatMap(UIPreview.init(rawValue:))
  }
}

// Canned rollups through the app's own core list: a preview proves only what the list ships if it derives the same
// way. `unseen` fakes a read mark under each count.
@MainActor
private final class PreviewList {
  let hostId = UUID().uuidString
  let list = SessionList(configJson: nil, marksJson: nil)
  private var infos: [String: SessionInfo] = [:]

  init(_ sessions: [[String: Any]], unseen: [String: Int] = [:], config: String? = nil) {
    if let config { list.setConfigJson(json: config) }
    var fed = sessions
    for index in fed.indices {
      guard let id = fed[index]["id"] as? String, let count = unseen[id] else { continue }
      _ = list.mark(hostId: hostId, sessionId: id, itemCount: nil, activity: 0, prose: 0, turns: 0, nowMs: 0)
      fed[index]["proseCount"] = count
    }
    let body = ListFixture.body(fed)
    _ = try? list.setHost(hostId: hostId, hostName: "mini", local: true, body: body)
    for info in ListFixture.infos(body) { infos["\(hostId):\(info.id)"] = info }
  }

  func sections() -> [ListSection] {
    list.sections(now: Date().timeIntervalSince1970 * 1000) { infos[$0] }
  }

  func info(_ member: TrayMember) -> SessionInfo? { infos[member.key] }
}

/// The grid, fed a stream with no socket behind it.
private struct TeamsPreview: View {
  private static var ago: Double { Date().timeIntervalSince1970 * 1000 - 6 * 60 * 1000 }

  private static func row(
    _ id: String, agent: [String: Any]?, status: String = "idle", pending: Int = 0, label: String? = nil,
    title: String? = nil, model: String = "claude-opus-5", asleep: Bool = false
  ) -> [String: Any] {
    var extra: [String: Any] = [
      "model": model, "pendingPermissionCount": pending, "lastActivityAt": ago,
      "contextUsage": ["totalTokens": 60_000, "maxTokens": 200_000, "percentage": 30],
    ]
    if let agent { extra["agent"] = agent }
    if let title { extra["title"] = title }
    if asleep { extra["engineAsleep"] = true }
    if let label { extra["statusLabel"] = ["text": label, "setAt": 0] }
    return ListFixture.session(id, status: status, extra)
  }

  private static func member(_ id: String, _ name: String, order: Int) -> [String: Any] {
    ["id": id, "name": name, "avatar": "/\(id)", "lead": "A", "team": "WD-Lead", "order": order]
  }

  @State private var model = PreviewList(
    [
      row("lead", agent: ["id": "A", "name": "WD-Lead", "avatar": "/a", "leads": true, "conversation": 4],
          status: "running", label: "cutting 3.13.0"),
      row("m1", agent: member("B", "WD-Review", order: 0), pending: 1, label: "needs your call"),
      row("m2", agent: member("C", "WD-MonkeyArt", order: 1), status: "running"),
      row("m3", agent: member("D", "WD-Docs", order: 2), asleep: true),
      row("solo", agent: ["id": "E", "name": "BOX-Lead", "avatar": "/e", "shared": true], label: "🧪 smoke green"),
      row("plain", agent: nil, status: "awaiting_approval", pending: 1, title: "Fix the relay drop", model: "gpt-6-sol"),
      row("old", agent: nil, status: "closed", title: "Old one-off"),
    ],
    unseen: ["lead": 2, "m2": 1],
    config: #"{"groupBy":"none"}"#)
  @State private var revision = 0

  private static func picture(_ seed: Int) -> AgentAvatarFrames {
    let hues: [CGFloat] = [0.08, 0.55, 0.33, 0.75, 0.95]
    let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { ctx in
      UIColor(hue: hues[seed % hues.count], saturation: 0.5, brightness: 0.85, alpha: 1).setFill()
      ctx.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
      UIColor(white: 0.15, alpha: 1).setFill()
      ctx.fill(CGRect(x: 4, y: 6, width: 2, height: 2))
      ctx.fill(CGRect(x: 10, y: 6, width: 2, height: 2))
      ctx.fill(CGRect(x: 5, y: 11, width: 6, height: 1))
    }
    return AgentAvatarFrames(still: image, busy: [], durations: [])
  }

  var body: some View {
    let _ = revision
    NavigationStack {
      List {
        ForEach(model.sections()) { section in
          Section {
            if !section.group.collapsed {
              ForEach(Array(section.items.enumerated()), id: \.element.id) { index, item in
                if item.row.depth > 0 {
                  AgentCardView(
                    item: item, frames: Self.picture(index), member: true, onOpen: {},
                    menu: { Button("Leave team") {} })
                  .listRowInsets(AgentCardView<EmptyView>.insets(member: true, hasSteps: false))
                  .listRowSeparator(.hidden)
                  .listRowBackground(
                    ZStack {
                      if item.needsYou { ListAttention.background }
                      TeamTreeLine()
                    })
                } else {
                  card(item, index: index)
                }
              }
            }
          } header: {
            if section.earlier {
              Button("Earlier \(section.group.sessions)") {
                model.list.toggleGroup(key: "earlier")
                revision += 1
              }
            }
          }
        }
      }
      .listStyle(.plain)
      .navigationTitle("Sessions")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  @ViewBuilder
  private func card(_ item: ListItem, index: Int) -> some View {
    if item.info.agent != nil {
      AgentCardView(
        item: item, frames: index == 0 ? Self.picture(0) : Self.picture(4),
        tray: item.row.tray.isEmpty && !item.row.teamExpanded
          ? nil
          : TeamTray(
            row: item.row, members: item.row.tray.compactMap { m in model.info(m).map { (m, $0) } },
            frames: { _, _ in Self.picture(1) }, select: { _ in },
            toggle: {
              model.list.toggleTeam(hostId: item.row.hostId, sessionId: item.row.sessionId)
              revision += 1
            }),
        onOpen: {}, menu: { Button("New conversation") {} })
      .listRowInsets(AgentCardView<EmptyView>.insets(member: false, hasSteps: false))
      .listRowBackground(item.needsYou ? ListAttention.background : nil)
    } else {
      SessionCardView(item: item, onOpen: {}, menu: { Button("Close") {} })
        .listRowInsets(SessionCardView<EmptyView>.insets(hasSteps: false))
        .listRowBackground(item.needsYou ? ListAttention.background : nil)
    }
  }
}

/// The live list itself - the card, its disclosure, and the step rows that hang
/// under an open one.
///
/// The phone's answer to the dashboard's `Sessions/SessionItem` `TheList` story,
/// and it exists for the same reason: the row's difficulty is what the pieces do
/// to each other in a column of them, which no single-row preview can show. Same
/// six sessions, same order, so the two can be put side by side.
private struct SessionsPreview: View {
  private static var now: Double { Date().timeIntervalSince1970 * 1000 }

  private static func row(
    id: String, title: String, status: String = "running", engine: String = "claude", model: String = "claude-opus-5",
    profile: String? = nil, cost: Double? = nil, context: Double? = nil, pending: Int = 0,
    subagents: [[String: Any]]? = nil, checklist: [[String: Any]]? = nil, shells: [[String: Any]]? = nil
  ) -> [String: Any] {
    var extra: [String: Any] = [
      "engine": engine, "model": model, "pendingPermissionCount": pending, "title": title,
      "lastActivityAt": now - 4 * 60 * 1000,
      "project": [
        "name": "WorkerDeck", "root": "/Users/you/projects/workerdeck", "icon": ["type": "glyph", "name": "layers"],
      ],
    ]
    if let profile { extra["profile"] = profile }
    if let cost { extra["totalCostUsd"] = cost }
    if let context {
      extra["contextUsage"] = ["totalTokens": Int(context * 2_000), "maxTokens": 200_000, "percentage": context]
    }
    if let subagents { extra["subagents"] = subagents }
    if let checklist { extra["checklist"] = checklist }
    if let shells { extra["shells"] = shells }
    return ListFixture.session(id, status: status, extra)
  }

  private static func agent(_ id: String, _ type: String, _ status: String, tools: Int) -> [String: Any] {
    [
      "toolUseId": id, "agentType": type, "description": "Fix base-url and re-run", "status": status, "startedAt": 0,
      "toolCount": tools,
    ]
  }

  private static var agents: [[String: Any]] {
    [agent("a", "Explore", "done", tools: 4), agent("b", "Explore", "running", tools: 7), agent("c", "fable", "done", tools: 0)]
  }

  private static var checklist: [[String: Any]] {
    [
      ["text": "Read the runner", "status": "completed"],
      ["text": "Rewrite the fold", "status": "in_progress"],
      ["text": "Update the docs", "status": "pending"],
    ]
  }

  private static func shell(_ id: String, _ ordinal: Int, _ command: String, _ extra: [String: Any]) -> [String: Any] {
    var base: [String: Any] = [
      "id": id, "sessionId": "3", "ordinal": ordinal, "command": command, "label": command,
      "cwd": "/Users/you/projects/workerdeck", "owner": "user", "bytes": 0, "cols": 80, "rows": 24,
    ]
    base.merge(extra) { _, new in new }
    return base
  }

  private static var server: [[String: Any]] {
    [
      shell("sh1", 1, "pnpm dev --port 4179", ["status": "running", "startedAt": now - 60_000]),
      shell(
        "sh2", 2, "pnpm test",
        ["status": "exited", "startedAt": now - 50_000, "endedAt": now - 20_000, "exitCode": 1, "endReason": "exit"]),
    ]
  }

  private static var background: [[String: Any]] {
    agents + [
      [
        "toolUseId": "bg", "description": "node packages/cli/cli.ts --port 4179", "status": "running", "startedAt": 0,
        "toolCount": 0, "stoppable": true,
      ]
    ]
  }

  @State private var model = PreviewList(
    [
      row(id: "1", title: "Session 1 Title", context: 34, subagents: agents),
      row(id: "2", title: "Session 2 Title", status: "idle", context: 62, checklist: checklist),
      row(id: "3", title: "Session 3 Title", context: 34, subagents: background, checklist: checklist, shells: server),
      row(
        id: "4", title: "Rework the transcript reducer so replay holds across reconnects", profile: "staging",
        cost: 12.4, context: 88, subagents: agents),
      row(id: "5", title: "Session 6 Title", status: "awaiting_approval", context: 12, pending: 1),
      row(id: "6", title: "Codex parity sweep", engine: "codex", model: "gpt-5-codex", context: 41),
    ],
    unseen: ["1": 5, "2": 3, "3": 5, "4": 3, "5": 12],
    config: #"{"groupBy":"none"}"#)
  // The core list is not observable: the filter menu bumps this so the rows redraw.
  @State private var revision = 0
  @State private var path: [SessionRoute] = []

  var body: some View {
    NavigationStack(path: $path) {
      List {
        let _ = revision
        ForEach(model.sections().flatMap(\.items)) { item in
          SessionCardView(
            item: item, onOpen: { item.hostUUID.map { path.append(.session(hostId: $0, sessionId: item.info.id)) } },
            hostName: item.row.hostName,
            // The app's own actions, spelled out rather than left empty: the
            // menu is part of what this harness exists to check.
            menu: {
              Button { } label: { Label("Rename", systemImage: "pencil") }
              Button(role: .destructive) { } label: { Label("Close", systemImage: "xmark.circle") }
            })
          .listRowInsets(SessionCardView<EmptyView>.insets(hasSteps: !item.row.steps.isEmpty))
          .listRowSeparator(item.row.steps.isEmpty ? .automatic : .hidden, edges: .bottom)
          SessionStepRows(row: item, steps: item.row.steps) { step in
            step.killable ? {} : nil
          }
        }
      }
      .listStyle(.plain)
      .environment(\.defaultMinListRowHeight, SessionStepRow.height)
      .navigationTitle("Sessions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(id: "search", placement: .topBarTrailing) {
          Button {} label: { Label("Search", systemImage: "magnifyingglass") }
        }
        ToolbarItem(id: "filter", placement: .topBarTrailing) {
          let _ = revision
          FilterMenu(
            filter: model.list.filter(), hosts: [], adapters: ["claude", "codex"], projects: [], list: model.list,
            changed: { revision += 1 })
        }
      }
      .navigationDestination(for: SessionRoute.self) { route in
        Text(String(describing: route)).font(.caption.monospaced()).padding()
      }
    }
  }
}

/// The sessions list's second line, in every project state it has.
///
/// The claim being checked is not "does this look right" but **"does each rule
/// actually fire"** - the project replacing a path, the relative half appearing
/// and disappearing, a glyph this build cannot map falling back to a folder
/// rather than a hole, and an SVG (which Apple cannot decode from bytes at all)
/// degrading to the name rather than to a gap. Every one of those needs a
/// differently-configured gateway to produce for real, which is exactly what
/// this harness is for.
private struct ProjectsPreview: View {
  private static func session(
    id: String, title: String, cwd: String, project: ProjectInfo? = nil,
    status: SessionStatus = .idle, pending: Int = 0, context: Double? = nil,
    cost: Double? = nil
  ) -> SessionInfo {
    SessionInfo(
      id: id, status: status, cwd: cwd, engine: .claude, model: "claude-opus-5",
      createdAt: 0, lastSeq: 0, pendingPermissionCount: pending, title: title,
      totalCostUsd: cost,
      // A plausible age: `lastActivityAt` is epoch **ms**, and a fixture that
      // reads "20684d" is a fixture nobody trusts the rest of.
      lastActivityAt: Date().timeIntervalSince1970 * 1000 - 15 * 60 * 1000,
      project: project,
      // The percentage is the only field the ring reads; the tokens are what a
      // long-press would say, so they are plausible rather than derived.
      contextUsage: context.map {
        ContextReading(totalTokens: Int($0 * 2_000), maxTokens: 200_000, percentage: $0)
      })
  }

  /// A coloured square, so "the bytes arrived" is unmistakable against "they
  /// did not".
  ///
  /// Deliberately drawn **oversized and then put through the row's own
  /// `fittedToProjectGlyphBox()`** - the same call `ProjectIconLoader` makes on
  /// the way in. This fixture stands in for the loader, so it has to honour the
  /// loader's contract: the row draws this glyph *inside* a `Text` run, where
  /// there is no `.frame` to constrain a picture, so whatever arrives is what
  /// gets drawn. A fixture that quietly handed over a pre-sized image would
  /// prove nothing about the real path and hide the one way it can go wrong.
  private static var pngBytes: UIImage? {
    UIGraphicsImageRenderer(size: .init(width: 128, height: 128)).image { ctx in
      UIColor.systemIndigo.setFill()
      ctx.fill(CGRect(x: 0, y: 0, width: 128, height: 128))
    }
    .fittedToProjectGlyphBox()
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
        caption: "bytes not in yet - no hole, no placeholder box",
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
        caption: "cwd NOT under root (a symlinked start) - name alone, never a wrong path",
        session: Self.session(
          id: "7", title: "Through a symlink", cwd: "/tmp/deck-link/packages/ui",
          project: ProjectInfo(name: "WorkerDeck", root: "/private/tmp/deck", icon: nil))),
      Case(
        caption: "no .workerdeck.json anywhere above it - the folder name, no path",
        session: Self.session(
          id: "8", title: "Launch preparation",
          cwd: "/Users/you/projects/atomic/services/gtm")),
      // The three states of the ring, side by side: the ramp is the claim, and
      // one screenshot of one percentage cannot show a ramp. The last row also
      // has no reading at all - the case the ring must draw *nothing* for.
      Case(
        caption: "context ring: comfortable",
        session: Self.session(
          id: "9", title: "Room to work", cwd: "/Users/you/projects/workerdeck",
          project: wd, context: 34, cost: 0.42)),
      Case(
        caption: "context ring: filling up (past 80, where a ring turns - a bar turns at 70)",
        session: Self.session(
          id: "10", title: "Getting long", cwd: "/Users/you/projects/workerdeck",
          project: wd, status: .running, context: 84, cost: 3.10)),
      Case(
        caption: "context ring: nearly out (past 95), and waiting on a person",
        session: Self.session(
          id: "11", title: "Almost full", cwd: "/Users/you/projects/workerdeck",
          project: wd, status: .awaitingApproval, pending: 2, context: 96, cost: 12.80)),
      Case(
        caption: "no reading at all - draws NO ring, never an empty one",
        session: Self.session(
          id: "12", title: "Never run", cwd: "/Users/you/projects/workerdeck", project: wd)),
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
/// Every step-row rule on one screen - see `UIPREVIEW=steps` in the switch below.
private struct StepsPreview: View {
  private static func sub(_ id: String, agent: String?, description: String?, status: String, tools: Int) -> [String: Any] {
    var out: [String: Any] = ["toolUseId": id, "status": status, "startedAt": 0, "toolCount": tools]
    if let agent { out["agentType"] = agent }
    if let description { out["description"] = description }
    return out
  }

  /// Deliberately interleaved on the wire: the fixture only proves the sort if
  /// the input is out of order. Dispatch order here is task, agent, task,
  /// agent, agent, task - and the screen must read agents first, each group
  /// still in the order it arrived.
  @State private var model = PreviewList(
    [
      ListFixture.session(
        "s1", status: "running",
        [
          "engine": "claude", "title": "Mixed steps", "lastActivityAt": Date().timeIntervalSince1970 * 1000 - 60_000,
          "subagents": [
            sub("t1", agent: nil, description: "rewrite the height budget", status: "done", tools: 0),
            sub("a1", agent: "Explore", description: "map the web theme", status: "running", tools: 7),
            sub("t2", agent: nil, description: "check a capture", status: "running", tools: 0),
            sub("a2", agent: "Plan", description: "size the port", status: "failed", tools: 2),
            // No description: the label falls back to the bare type.
            sub("a3", agent: "general-purpose", description: nil, status: "done", tools: 0),
            sub("t3", agent: nil, description: "and a task that failed", status: "failed", tools: 0),
          ],
        ])
    ],
    config: #"{"subagents":"all","tasks":"all"}"#)

  private static let hostId = UUID()

  var body: some View {
    let steps = model.sections().flatMap(\.items).first?.row.steps ?? []
    // Inside a stack, and each row is the `NavigationLink` the list gives it -
    // a bare `SessionStepRow` is a *simpler* composition than the app ships, and
    // where a press goes is half of what these rows are for. The destination
    // prints the route, so "the press landed on this step" and "the press opened
    // the session at the tail" stop looking alike.
    NavigationStack {
      List {
        Section {
          ForEach(steps) { step in
            NavigationLink(
              value: SessionRoute.step(hostId: Self.hostId, sessionId: "s1", step: step)
            ) {
              SessionStepRow(step: step)
            }
            .listRowInsets(SessionStepRow.insets)
          }
        } header: {
          Text("\(steps.count) steps")
        } footer: {
          Text(
            """
            Expected, top to bottom: Explore (green, spinner, 7) · Plan (RED, alarm, 2) · \
            general-purpose (green, tick, no count), then the three untyped records as tasks \
            in dispatch order (grey tick, grey spinner, RED alarm). An agent frames its \
            takeover; a task reveals its tool call.
            """)
        }
      }
      .navigationDestination(for: SessionRoute.self) { route in
        Text(String(describing: route)).font(.caption.monospaced()).padding()
      }
    }
  }
}

struct UIPreviewHarness: View {
  let variant: UIPreview
  /// Editing a fixture and watching it land is the whole point of this screen.
  @HotReloaded private var hot

  var body: some View {
    switch variant {
    case .steps:
      // The step rows under a session card, which the list only ever shows a
      // couple of at a time and never all four states at once. This is the
      // phone's answer to the dashboard's selection stories: the claim is not
      // "does this look right" but **"does each rule fire"** - agents above
      // tasks whatever order they arrived in, a failed agent drawing an alarm
      // rather than a checkmark, a task's neutral dot where an agent gets a
      // tick, green for the kind and red for the failure that outranks it, and
      // a zero tool count drawing nothing at all.
      StepsPreview()

    case .sessions:
      SessionsPreview()

    case .teams:
      TeamsPreview()

    case .core:
      NavigationStack {
        CoreSessionView(
          fixture: CoreReplayFixture.frames,
          recap: ProcessInfo.processInfo.environment["UIPREVIEW_RECAP"].flatMap(Int.init).map {
            CatchUpMark(itemCount: $0, seenAt: Date().timeIntervalSince1970 * 1000 - 42 * 60 * 1000)
          })
      }
      .environment(AppSettings())
      .environment(UnreadModel())
      .environment(PushCoordinator())

    case .projects:
      // Every shape line two can take, because each one is a different rule and
      // most need a differently-configured gateway to reach for real.
      ProjectsPreview()

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
