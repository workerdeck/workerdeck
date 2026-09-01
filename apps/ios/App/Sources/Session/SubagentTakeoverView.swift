import SwiftUI
import WorkerDeckKit

/// The sub-agent takeover: the screen becomes one agent's own work, with the
/// navigation bar as the way back — the phone's shape for what `packages/ui`'s
/// `SessionPanel` does with `subagentId` and `SubagentStrip`.
///
/// **Not a second attach.** This view captures the session screen's own
/// `TranscriptViewModel` and reads the same reduced state; what it adds is a
/// screen claim (`holdOpen`) so the one socket outlives the push, and a frame
/// (`subagentItems`, via `TerminalTranscriptView`'s `frame:`) so the rows shown
/// are exactly the membership the web takeover shows.
///
/// Two decisions carried over from the web, recorded in `docs/PACKAGES.md`:
/// the **composer goes** — you talk to the session, not to one of its agents —
/// but the **approvals stay**: a sub-agent's own tool calls raise session-level
/// permission requests, and hiding them here would deadlock the very agent
/// being watched. And the takeover **never auto-exits**: a `Task` call the
/// transcript does not have draws one honest line, and the reader leaves when
/// they choose.
struct SubagentTakeoverView: View {
  let taskId: String
  /// The gateway this session belongs to — the watermark key's first half,
  /// for the unread marks that keep flowing while this screen is the session.
  let hostId: UUID
  let vm: TranscriptViewModel

  @Environment(\.scenePhase) private var scenePhase
  @Environment(PushCoordinator.self) private var push
  @Environment(UnreadModel.self) private var unread
  @Environment(AppSettings.self) private var settings
  @Environment(BookmarkModel.self) private var bookmarks

  /// The frame's own scroll — fresh per open, so the takeover lands pinned to
  /// its own bottom: the live tail of a running agent, and the final report of
  /// a settled one.
  @State private var scroll = TranscriptScrollModel()
  /// Measured for the approval prompt's cap, exactly as on the session screen:
  /// a constant that fits an SE wastes half a Pro Max.
  @State private var containerHeight: CGFloat = 0

  /// The same pair the session screen marks seen on. Its own copy because the
  /// session view's per-event task dies with its `.task` when this screen
  /// covers it — and the frame's rows are still landing on a watched screen.
  private struct SeenKey: Hashable {
    var revision: Int
    var attached: Bool
  }

  /// The spawning call, when the transcript has it — the strip's one source of
  /// truth. The rollup below is allowed only to *name* an agent this cannot.
  /// The kit's lookup, shared with the transcript view's brief row, so the
  /// strip and the frame cannot disagree about what "the task" is.
  private var task: ToolCallItem? {
    subagentTask(vm.state.items, id: taskId)
  }

  private var frameItems: [TranscriptItem] {
    subagentItems(vm.state.items, parentToolUseId: taskId)
  }

  /// The one thing `SessionInfo.subagents` may do here: name an agent whose
  /// `Task` call is not in the transcript. A label is not content — the rollup
  /// keeps only eight settled records and can never be what a frame shows.
  private var fallbackLabel: String {
    vm.session?.subagents?.first(where: { $0.toolUseId == taskId }).map(subagentLabel)
      ?? "Sub-agent"
  }

  private var strip: SubagentStripLine {
    subagentStripLine(task: task, items: frameItems, fallbackLabel: fallbackLabel)
  }

  var body: some View {
    Group {
      if vm.replaying {
        // A reconnect can re-arm the replay hold under an open takeover; the
        // same spinner-and-counter the session screen shows, because a blank
        // frame is indistinguishable from a dead one.
        if let progress = vm.replayProgress {
          VStack(spacing: 6) {
            ProgressView()
            Text("\(progress.seq.formatted()) / \(progress.target.formatted())")
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
              .monospacedDigit()
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          Color.clear
        }
      } else if task == nil {
        // The frame's two empty states are two different facts, and this is
        // the second: a task the transcript does not have — a `/clear` retired
        // the conversation it lived in, or the id was never this session's.
        // (The first — an agent that has not spoken yet — is simply an empty
        // transcript under a strip saying `working…`.) Never auto-exit on
        // this: navigating out from under a reader is worse than one honest
        // line they can leave when they choose.
        Text("This sub-agent's work is not in this transcript.")
          .font(.body)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if settings.transcriptVariant.isTerminal {
        // The approvals ride along for the rail's sake: its approval mark pins
        // at the rail's foot, which is where this screen's own footer shows the
        // prompt — the same pairing the session screen has, and the web passes
        // `state.pendingApprovals` into a frame's rows for the same reason.
        // The same bookmark set the session screen passes, and it can be the
        // same only because the seam is item ids: inside the frame each id
        // resolves against the frame's own items or draws nothing, and a mark
        // set here is the same mark the top-level rail shows on the Task row
        // that absorbed it. Same session, same store, same key.
        TerminalTranscriptView(
          items: vm.state.items, pendingApprovals: vm.state.pendingApprovals,
          revision: vm.revision, scroll: scroll, frame: taskId,
          bookmarks: bookmarks.bookmarks(host: hostId, sessionId: vm.sessionId),
          onToggleBookmark: { bookmarks.toggle(host: hostId, sessionId: vm.sessionId, itemId: $0) })
      } else {
        // The cards renderer folds nothing, so the frame is the filtered items
        // handed to it directly — the same membership, the plainer surface.
        TranscriptListView(items: frameItems, revision: vm.revision)
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) { stripView }
    .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    .background(
      GeometryReader { proxy in
        Color.clear.preference(key: TakeoverHeight.self, value: proxy.size.height)
      }
    )
    .onPreferenceChange(TakeoverHeight.self) { containerHeight = $0 }
    .navigationTitle(strip.name)
    .navigationBarTitleDisplayMode(.inline)
    .transcriptPreferences(settings)
    // The second screen claim — what keeps the one attach alive across the
    // push, since the session view's own `.task` is cancelled once it is
    // covered. See `TranscriptViewModel.holdOpen`.
    .task { await vm.holdOpen() }
    // The session view's scene-phase handler sits on a covered view while this
    // screen is up; the claim and the backoff skip have to live where the
    // reader actually is.
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { vm.reconnectNow() }
      push.visibleSessionId = phase == .active ? vm.sessionId : nil
    }
    // The unread watermark keeps moving while the takeover is the session on
    // screen — the session view's per-event mark died with its `.task`.
    .task(id: SeenKey(revision: vm.revision, attached: vm.session != nil)) {
      guard scenePhase == .active, let info = vm.session else { return }
      unread.mark(
        host: hostId, sessionId: vm.sessionId, itemCount: vm.state.items.count, info: info)
    }
  }

  // MARK: - The strip

  /// The line above the frame: how the agent is doing and how much it has done
  /// — `SubagentStrip` minus the way back (the navigation bar's) and minus the
  /// name (the title's). Silent when the transcript has no `Task` call to
  /// read: better than confidently wrong about an agent we cannot see.
  @ViewBuilder private var stripView: some View {
    let line = strip
    if let status = line.status {
      let terminal = settings.transcriptVariant.isTerminal
      let typography = TerminalTypography.session
      HStack(spacing: 0) {
        SubagentStripGlyph(busy: line.busy, failed: line.failed, terminal: terminal)
          .frame(width: terminal ? typography.cell * 2 : 20, alignment: .leading)
        Text(stripText(status: status, tools: line.toolCount))
          .lineLimit(1)
        Spacer(minLength: 0)
      }
      .font(terminal ? typography.font : .caption)
      .foregroundStyle(
        line.failed
          ? TerminalPalette.color(.red)
          : line.busy ? TerminalPalette.color(.mark) : TerminalPalette.color(.dim)
      )
      .padding(.horizontal, terminal ? typography.cell : 12)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(uiColor: .systemBackground))
      .overlay(alignment: .bottom) { Divider() }
    }
  }

  /// The theme's own vocabulary, spelled once in the kit (`subagentStripLine`)
  /// and joined here the way the web strip joins it: `working… · 3 tools`.
  private func stripText(status: String, tools: Int) -> String {
    tools > 0 ? "\(status) · \(tools) tool\(tools == 1 ? "" : "s")" : status
  }

  // MARK: - The footer

  /// The approvals, and only the approvals: the composer belongs to the
  /// conversation, but a permission request is session-level however deep the
  /// call that raised it — hiding it here would deadlock the agent on screen.
  @ViewBuilder private var footer: some View {
    if let request = vm.pendingApproval {
      VStack(alignment: .leading, spacing: 4) {
        let waiting = vm.state.pendingApprovals.count
        if waiting > 1 {
          Text("1 of \(waiting) waiting")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .accessibilityLabel("\(waiting) requests waiting for you")
        }
        ApprovalPromptHost(
          request: request,
          isTerminal: settings.transcriptVariant.isTerminal,
          maxBodyHeight: max(220, containerHeight * 0.5),
          vm: vm)
      }
      .padding(.horizontal, 12)
      .padding(.top, 8)
      .padding(.bottom, 8)
    }
  }
}

/// The gutter mark: the brand pulse while the agent works, the theme's bullet
/// once it has settled. The beat is in the glyph, as it is on the `Task` row
/// this screen was opened from — and it rests on the pulse's last frame under
/// Reduce Motion, which is free: the last frame *is* the mark.
private struct SubagentStripGlyph: View {
  let busy: Bool
  let failed: Bool
  let terminal: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if busy && !reduceMotion {
      TimelineView(.periodic(from: .now, by: TermGlyph.pulseInterval)) { context in
        let tick = Int(
          context.date.timeIntervalSinceReferenceDate / TermGlyph.pulseInterval)
        Text(TermGlyph.pulseFrames[tick % TermGlyph.pulseFrames.count])
      }
    } else {
      Text(busy ? TermGlyph.pulseRest : TermGlyph.bullet)
        .foregroundStyle(
          failed ? TerminalPalette.color(.red) : TerminalPalette.color(busy ? .mark : .dim))
    }
  }
}

/// The one approval prompt, in whichever of the two renderers the reader is in
/// — shared by the session screen's floating stack and the takeover's footer,
/// because a prompt that could only be answered on one of the two surfaces the
/// session shows on would be the deadlock in a thinner disguise.
///
/// Two renderers, not two code paths through one — the same split the
/// transcript makes; see the session view's comment on the retired `lines`
/// variant.
struct ApprovalPromptHost: View {
  let request: PermissionRequest
  let isTerminal: Bool
  let maxBodyHeight: CGFloat
  let vm: TranscriptViewModel

  var body: some View {
    let questions = parseUserQuestions(request)
    if isTerminal {
      if questions.isEmpty {
        TerminalPermissionPromptView(
          request: request,
          maxBodyHeight: maxBodyHeight,
          onAllow: { vm.approve(request.id) },
          onDeny: { message, interrupt in
            vm.deny(request.id, message: message, interrupt: interrupt)
          })
      } else {
        TerminalQuestionPromptView(
          request: request,
          questions: questions,
          maxBodyHeight: maxBodyHeight,
          onAnswer: { input in vm.approve(request.id, updatedInput: input) },
          onDismiss: { vm.deny(request.id, message: "Question dismissed by user") })
      }
    } else if questions.isEmpty {
      PermissionPromptView(
        request: request,
        maxBodyHeight: maxBodyHeight,
        onAllow: { vm.approve(request.id) },
        onDeny: { message, interrupt in
          vm.deny(request.id, message: message, interrupt: interrupt)
        })
    } else {
      QuestionPromptView(
        request: request,
        questions: questions,
        maxBodyHeight: maxBodyHeight,
        onAnswer: { input in vm.approve(request.id, updatedInput: input) },
        onDismiss: { vm.deny(request.id, message: "Question dismissed by user") })
    }
  }
}

private struct TakeoverHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}
