import ActivityKit
import SwiftUI
import WidgetKit
import WorkerDeckActivity

/// The Live Activity: one card per engaged session, on the lock screen and in the Dynamic Island.
///
/// This target draws and nothing else. It holds no credential, opens no socket, and reads no
/// Keychain - a button's `LiveActivityIntent` is performed by the app process, not here. Keep it
/// that way: an extension that needs a secret is a second place the gateway key lives.
///
/// Layout follows `_docs/features/LIVE-ACTIVITY-DESIGN.md`: four bands at four clearly different
/// weights, with the hero swapping by phase. A reader glancing at a locked phone is asking one
/// question - *does it need me?* - and the hero is the answer.
struct SessionActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SessionActivityAttributes.self) { context in
      LockScreenCard(attributes: context.attributes, state: context.state, stale: context.isStale)
        .activityBackgroundTint(Color.black.opacity(0.55))
        .activitySystemActionForegroundColor(.primary)
        .widgetURL(sessionURL(context.attributes, context.state))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label(context.attributes.cwdLeaf, systemImage: engineSymbol(context.attributes.engine))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Clock(state: context.state).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 8) {
            Hero(state: context.state, stale: context.isStale)
            Sub(state: context.state)
            AgentLine(state: context.state)
            StepBar(state: context.state)
            ActionRow(attributes: context.attributes, state: context.state)
          }
        }
      } compactLeading: {
        Image(systemName: engineSymbol(context.attributes.engine))
          .foregroundStyle(accent(context.state, stale: context.isStale))
      } compactTrailing: {
        CompactTrailing(state: context.state)
      } minimal: {
        Minimal(state: context.state, stale: context.isStale)
      }
      .widgetURL(sessionURL(context.attributes, context.state))
    }
    // The iOS 18 Smart Stack on the watch. Title and headline only: the buttons are not reachable
    // there and a truncated command preview is worse than none.
    .supplementalActivityFamilies([.small])
  }
}

// The deep link a tap produces, in the same shape a notification tap does, so both land through one
// `PushRoute` and one `deepLinkSeqSurvives` rule.
private func sessionURL(_ attributes: SessionActivityAttributes, _ state: SessionActivityAttributes.ContentState) -> URL? {
  var components = URLComponents()
  components.scheme = "workerdeck"
  components.host = "session"
  components.queryItems =
    [URLQueryItem(name: "id", value: attributes.sessionId)]
    + (attributes.hostId.map { [URLQueryItem(name: "host", value: $0)] } ?? [])
    + (state.seq.map { [URLQueryItem(name: "seq", value: String($0))] } ?? [])
    + (state.epoch.map { [URLQueryItem(name: "epoch", value: String($0))] } ?? [])
  return components.url
}

private func engineSymbol(_ engine: String?) -> String {
  switch engine {
  case "codex": return "chevron.left.forwardslash.chevron.right"
  case "claude": return "sparkle"
  default: return "cpu"
  }
}

/// One colour decides the whole card's temperature, and it answers "does this need me?".
private func accent(_ state: SessionActivityAttributes.ContentState, stale: Bool) -> Color {
  if stale || state.decision != nil { return .secondary }
  if SessionActivityPhase.isWaiting(state.phase) { return .orange }
  if state.phase == SessionActivityPhase.failed { return .red }
  if SessionActivityPhase.isFinal(state.phase) { return .secondary }
  return .green
}

private struct LockScreenCard: View {
  let attributes: SessionActivityAttributes
  let state: SessionActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Header(attributes: attributes, state: state, stale: stale)
      Hero(state: state, stale: stale)
      Sub(state: state)
      AgentLine(state: state)
      StepBar(state: state)
      ActionRow(attributes: attributes, state: state)
    }
    .padding(14)
  }
}

// MARK: - Band 1: context

private struct Header: View {
  let attributes: SessionActivityAttributes
  let state: SessionActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: engineSymbol(attributes.engine))
        .font(.caption2)
        .foregroundStyle(accent(state, stale: stale))
      Text(attributes.cwdLeaf).font(.caption2.weight(.medium))
      Text("·").font(.caption2)
      Text(state.title).font(.caption2).lineLimit(1)
      Spacer(minLength: 8)
      if stale {
        // The gateway stopped talking. Saying so beats a clock that keeps counting for a turn that
        // died with the process running it.
        Label("Lost contact", systemImage: "wifi.slash").font(.caption2)
      } else {
        Clock(state: state).font(.caption2.monospacedDigit())
      }
    }
    .foregroundStyle(.secondary)
  }
}

/// Elapsed while running, counting down while a request expires. Both are drawn by the system from
/// a date, so neither costs a push.
private struct Clock: View {
  let state: SessionActivityAttributes.ContentState

  var body: some View {
    if SessionActivityPhase.isFinal(state.phase) {
      Text(finalWord(state.phase))
    } else if let expires = state.expiresAtMs, SessionActivityPhase.isWaiting(state.phase) {
      Text(Date(timeIntervalSince1970: expires / 1000), style: .timer)
    } else {
      Text(Date(timeIntervalSince1970: state.startedAtMs / 1000), style: .timer)
    }
  }
}

private func finalWord(_ phase: String) -> String {
  switch phase {
  case SessionActivityPhase.failed: return "Failed"
  case SessionActivityPhase.parked: return "Parked"
  default: return "Done"
  }
}

// MARK: - Band 2: the hero

/// The one line worth reading from across a desk. A decision in flight replaces it, because after
/// a tap the only thing the reader wants is confirmation that the tap landed.
private struct Hero: View {
  let state: SessionActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    Text(text)
      .font(.title3.weight(.semibold))
      .foregroundStyle(tint)
      .lineLimit(1)
      .minimumScaleFactor(0.8)
  }

  private var text: String {
    if let decision = state.decision { return decisionLabel(decision) }
    if SessionActivityPhase.isWaiting(state.phase) {
      return state.pendingCount > 1 ? "\(state.pendingCount) approvals waiting" : "Waiting on you"
    }
    return state.headline
  }

  private var tint: Color {
    if stale || state.decision != nil { return .secondary }
    if SessionActivityPhase.isWaiting(state.phase) { return .orange }
    if SessionActivityPhase.isFinal(state.phase) { return .secondary }
    return .primary
  }
}

// MARK: - Band 3: the detail

private struct Sub: View {
  let state: SessionActivityAttributes.ContentState

  var body: some View {
    // When the hero was taken by "Waiting on you", the headline still carries the tool name, and
    // it belongs above the command rather than being dropped.
    if SessionActivityPhase.isWaiting(state.phase), state.decision == nil {
      VStack(alignment: .leading, spacing: 2) {
        Text(state.headline).font(.caption.weight(.medium)).lineLimit(1)
        detail
      }
    } else {
      detail
    }
  }

  @ViewBuilder private var detail: some View {
    if let text = state.detail {
      Text(text)
        .font(.caption2.monospaced())
        .foregroundStyle(.secondary)
        .lineLimit(2)
        // Bystander-readable on a locked screen, and iOS's "Show Previews: When Unlocked" does not
        // govern Live Activities - this is the only thing that redacts a command.
        .privacySensitive()
    }
  }
}

/// The sub-agents, as one line of counts. Names would need a row each and the card has no room;
/// the app is where a fan-out is read.
private struct AgentLine: View {
  let state: SessionActivityAttributes.ContentState

  var body: some View {
    if let summary = SessionActivityAgents.summary(state.agents) {
      Label(summary, systemImage: "point.3.connected.trianglepath.dotted")
        .font(.caption2)
        .foregroundStyle(SessionActivityAgents.runningCount(state.agents) > 0 ? .primary : .secondary)
        .lineLimit(1)
    }
  }
}

// MARK: - Band 4: progress

private struct StepBar: View {
  let state: SessionActivityAttributes.ContentState

  var body: some View {
    if let steps = state.steps, steps.total > 0 {
      VStack(alignment: .leading, spacing: 3) {
        GeometryReader { geometry in
          ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.18))
            Capsule()
              .fill(SessionActivityPhase.isWaiting(state.phase) ? Color.orange : Color.green)
              .frame(width: geometry.size.width * fraction(steps))
          }
        }
        .frame(height: 3)
        Text("\(steps.done) of \(steps.total)")
          .font(.caption2.monospacedDigit())
          .foregroundStyle(.secondary)
      }
    }
  }

  private func fraction(_ steps: SessionActivityAttributes.Steps) -> Double {
    min(1, max(0, Double(steps.done) / Double(steps.total)))
  }
}

private struct CompactTrailing: View {
  let state: SessionActivityAttributes.ContentState

  var body: some View {
    if SessionActivityPhase.isWaiting(state.phase) {
      Image(systemName: "questionmark.circle.fill").foregroundStyle(.orange)
    } else if agents > 0 {
      Label("\(agents)", systemImage: "point.3.connected.trianglepath.dotted").font(.caption2.monospacedDigit())
    } else if let steps = state.steps, steps.total > 0 {
      Text("\(steps.done)/\(steps.total)").font(.caption2.monospacedDigit())
    } else {
      Text(Date(timeIntervalSince1970: state.startedAtMs / 1000), style: .timer)
        .font(.caption2.monospacedDigit())
        .frame(maxWidth: 44)
    }
  }

  private var agents: Int { SessionActivityAgents.runningCount(state.agents) }
}

/// One slot, so the count wins over the glyph: how many agents are out is the only number that
/// fits, and a waiting card still says so first.
private struct Minimal: View {
  let state: SessionActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    let agents = SessionActivityAgents.runningCount(state.agents)
    if !SessionActivityPhase.isWaiting(state.phase), agents > 0 {
      Text("\(agents)").font(.caption2.monospacedDigit()).foregroundStyle(accent(state, stale: stale))
    } else {
      Image(systemName: SessionActivityPhase.isWaiting(state.phase) ? "questionmark.circle.fill" : "circle.dotted")
        .foregroundStyle(accent(state, stale: stale))
    }
  }
}

private func decisionLabel(_ decision: String) -> String {
  switch decision {
  case SessionActivityDecision.sending: return "Sending…"
  case SessionActivityDecision.sent: return "Sent - waiting"
  case SessionActivityDecision.gone: return "Already answered"
  case SessionActivityDecision.parked: return "Session parked"
  case SessionActivityDecision.failed: return "Couldn't reach gateway"
  case SessionActivityDecision.locked: return "Unlock to approve"
  default: return decision
  }
}

// MARK: - Band 5: the actions

/// The buttons, or the honest absence of them.
///
/// A decision already in flight replaces the row rather than leaving buttons that would fire a
/// second time; the server's next push clears `decision` and the row comes back if it is still
/// needed.
private struct ActionRow: View {
  let attributes: SessionActivityAttributes
  let state: SessionActivityAttributes.ContentState

  var body: some View {
    if let request = state.request, state.decision == nil, SessionActivityPhase.isWaiting(state.phase) {
      if request.choices.isEmpty {
        HStack(spacing: 8) {
          Button(intent: denyIntent(request)) {
            Text(state.phase == SessionActivityPhase.plan ? "Keep planning" : "Deny")
              .font(.caption.weight(.semibold))
              .frame(maxWidth: .infinity)
          }
          .tint(.secondary)
          Button(intent: approveIntent(request)) {
            Text(state.phase == SessionActivityPhase.plan ? "Approve plan" : "Approve")
              .font(.caption.weight(.semibold))
              .frame(maxWidth: .infinity)
          }
          .tint(.orange)
        }
        .buttonStyle(.borderedProminent)
      } else {
        // A 2-wide grid: four options is the layout budget under the lock screen's 160 pt, and the
        // forwarder has already refused to send more than that.
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
          ForEach(request.choices, id: \.index) { choice in
            Button(intent: chooseIntent(request, choice.index)) {
              Text(choice.label)
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity)
            }
            .tint(.orange)
          }
        }
        .buttonStyle(.bordered)
      }
    }
  }

  private func approveIntent(_ request: SessionActivityAttributes.Request) -> ApproveSessionRequestIntent {
    ApproveSessionRequestIntent(sessionId: attributes.sessionId, hostId: attributes.hostId, requestId: request.id)
  }

  private func denyIntent(_ request: SessionActivityAttributes.Request) -> DenySessionRequestIntent {
    DenySessionRequestIntent(sessionId: attributes.sessionId, hostId: attributes.hostId, requestId: request.id)
  }

  private func chooseIntent(_ request: SessionActivityAttributes.Request, _ index: Int) -> ChooseSessionAnswerIntent {
    ChooseSessionAnswerIntent(
      sessionId: attributes.sessionId, hostId: attributes.hostId, requestId: request.id, choiceIndex: index)
  }
}
