import ActivityKit
import Observation
import UIKit
import WorkerDeckActivity
import WorkerDeckKit

/// Everything Live Activity on the app's side: the push-to-start token, the per-card update tokens,
/// and ending cards the gateway can no longer speak for.
///
/// The gateway *raises* cards; this never does. That is the whole point of push-to-start - a turn
/// begun from the web dashboard has to reach a phone whose app is not running, and only APNs can do
/// that. What the app owns is the two tokens and the reconcile.
@MainActor
@Observable
final class ActivityCoordinator {
  /// Hex push-to-start token, nil until ActivityKit hands one over. Device-level, like the APNs
  /// device token, and registered with every host the same way.
  private(set) var startToken: String?
  private(set) var lastError: String?

  private var hosts: HostStore?
  private weak var push: PushCoordinator?
  private var settings: AppSettings?
  /// Whether the ActivityKit streams are already running. `applyEnablement` may be called again
  /// every time the reader flips the switch, and a second set of watchers would report every token
  /// twice.
  private var watchingTokens = false
  /// `sessionId|token` pairs already reported, so re-reporting on every foreground is a no-op.
  private var reported: Set<String> = []
  private var watching = ActivityClaims()
  private var streams: [Task<Void, Never>] = []

  func attach(hosts: HostStore, push: PushCoordinator, settings: AppSettings) {
    guard self.hosts == nil else { return }
    self.hosts = hosts
    self.push = push
    self.settings = settings
    ActivityTrail.note("attach hosts=\(hosts.hosts.count) enabled=\(enabled)")
    watchEnablement()
    Task { await applyEnablement() }
  }

  /// Both switches have to be on: the system's, and the reader's. iOS owns the first (Settings ▸
  /// WorkerDeck ▸ Live Activities) and this app owns the second, but they mean the same thing to
  /// the gateway - no start token, no card.
  private var enabled: Bool {
    ActivityAuthorizationInfo().areActivitiesEnabled && (settings?.liveActivitiesEnabled ?? true)
  }

  /// Called at attach and every time either switch moves.
  func applyEnablement() async {
    guard enabled else {
      // Registering a start token the phone will ignore burns the gateway's push budget on cards
      // that never appear. Clearing it is what stops the next one being raised; ending the live
      // ones is what clears the ones already on screen - the gateway learns they are gone from the
      // detach that `watchState` fires, so it stops pushing updates into nothing.
      await clearStartToken()
      await endEveryCard()
      return
    }
    if !watchingTokens {
      watchingTokens = true
      watchStartTokens()
      watchActivities()
    }
    adoptRunning()
  }

  private nonisolated func endEveryCard() async {
    for activity in Activity<SessionActivityAttributes>.activities where activity.activityState == .active {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  // MARK: - Tokens

  private func watchStartTokens() {
    streams.append(
      Task { [weak self] in
        for await data in Activity<SessionActivityAttributes>.pushToStartTokenUpdates {
          let hex = data.map { String(format: "%02x", $0) }.joined()
          await self?.setStartToken(hex)
        }
      })
  }

  private func setStartToken(_ hex: String) async {
    guard hex != startToken else { return }
    startToken = hex
    push?.liveActivityStartToken = hex
    await push?.syncRegistrations(force: true)
  }

  private func clearStartToken() async {
    guard startToken != nil || push?.liveActivityStartToken != nil else { return }
    startToken = nil
    push?.liveActivityStartToken = nil
    await push?.syncRegistrations(force: true)
  }

  private func watchEnablement() {
    streams.append(
      Task { [weak self] in
        for await _ in ActivityAuthorizationInfo().activityEnablementUpdates {
          await self?.applyEnablement()
        }
      })
  }

  // MARK: - Cards
  //
  // Everything below that touches an `Activity` is **nonisolated**, and that is not a style choice.
  // `Activity` is not `Sendable` and ActivityKit's methods are nonisolated, so handling one on the
  // main actor makes every call into it a Swift 6 "sending" error. The rule that falls out is a good
  // one anyway: the activity stays in the nonisolated world, and only Strings - session ids, host
  // ids, hex tokens - ever cross onto the actor that holds this object's state.

  private nonisolated func watchActivities() {
    Task { [weak self] in
      for await activity in Activity<SessionActivityAttributes>.activityUpdates {
        await self?.handle(activity)
      }
    }
  }

  /// Cards that already existed when the app launched - a background wake for a push-to-start
  /// arrives with the activity already made.
  private nonisolated func adoptRunning() {
    Task { [weak self] in
      for activity in Activity<SessionActivityAttributes>.activities {
        await self?.handle(activity)
      }
    }
  }

  private nonisolated func handle(_ activity: Activity<SessionActivityAttributes>) async {
    let sessionId = activity.attributes.sessionId
    let hostId = activity.attributes.hostId
    guard !Self.isLocallyRaised(sessionId) else { return }
    ActivityTrail.note("saw \(sessionId.prefix(8)) state=\(activity.activityState)")
    // The two watchers take the activity's **id** and look it up again, rather than capturing the
    // activity: a non-Sendable value captured by a task closure is the same Swift 6 error in a
    // different costume, and an id is a String.
    let id = activity.id
    switch await claim(id: id, sessionId: sessionId, hostId: hostId) {
    case .alreadyWatched:
      return
    case .duplicate:
      ActivityTrail.note("dup-end \(sessionId.prefix(8))")
      // A second card for one session is the duplicate-start hazard arriving anyway. The gateway
      // guards against it; this is the last line, because two cards for one turn is the most
      // visible way this feature can look broken.
      if activity.activityState == .active {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      return
    case .fresh:
      break
    }
    Task { [weak self] in await self?.watchToken(id: id, sessionId: sessionId, hostId: hostId) }
    Task { [weak self] in await self?.watchState(id: id, sessionId: sessionId, hostId: hostId) }
    await reconcile()
  }

  private nonisolated func watchToken(id: String, sessionId: String, hostId: String?) async {
    guard let activity = Activity<SessionActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
    for await data in activity.pushTokenUpdates {
      let hex = data.map { String(format: "%02x", $0) }.joined()
      await report(sessionId: sessionId, hostId: hostId, token: hex)
    }
  }

  private nonisolated func watchState(id: String, sessionId: String, hostId: String?) async {
    guard let activity = Activity<SessionActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
    for await state in activity.activityStateUpdates {
      guard state == .ended || state == .dismissed else { continue }
      let token = activity.pushToken.map { data in data.map { String(format: "%02x", $0) }.joined() }
      await release(id: id, sessionId: sessionId, hostId: hostId, token: token)
    }
  }

  /// The app-side half of "one card per (host, session)". Logic and tests in `ActivityClaims`.
  private func claim(id: String, sessionId: String, hostId: String?) -> ActivityClaims.Claim {
    watching.claim(id: id, sessionId: sessionId, hostId: hostId)
  }

  private func report(sessionId: String, hostId: String?, token: String) async {
    let key = "\(sessionId)|\(token)"
    guard !reported.contains(key), let hosts else { return }
    // Named host first; without one, every host is asked and all but the owner answer 404.
    for host in matching(hostId: hostId, in: hosts) {
      do {
        if try await ActivityRegistration.attach(
          sessionId: sessionId, token: token, deviceToken: push?.deviceToken, host: host) == .attached
        {
          reported.insert(key)
          ActivityTrail.note("token-attached \(sessionId.prefix(8))")
          return
        }
      } catch {
        lastError = "\(host.displayName): \(error.localizedDescription)"
      }
    }
  }

  private func release(id: String, sessionId: String, hostId: String?, token: String?) async {
    watching.release(id: id, sessionId: sessionId, hostId: hostId)
    reported = reported.filter { !$0.hasPrefix("\(sessionId)|") }
    guard let hosts, let token else { return }
    for host in matching(hostId: hostId, in: hosts) {
      _ = try? await ActivityRegistration.detach(token: token, host: host)
    }
  }

  private func matching(hostId: String?, in hosts: HostStore) -> [Host] {
    if let hostId, let uuid = UUID(uuidString: hostId), let host = hosts.hosts.first(where: { $0.id == uuid }) {
      return [host]
    }
    return hosts.hosts.filter(\.isValid)
  }

  /// A card `ActivityDebug` raised belongs to no gateway, so every guard in this class reads it as
  /// garbage: the reconcile finds no such session and the duplicate check finds a second card for
  /// the same id. Both would end it within a second of the tap, which is indistinguishable from the
  /// card never appearing. It is the one card this class does not manage.
  private nonisolated static func isLocallyRaised(_ sessionId: String) -> Bool {
    #if DEBUG
      return sessionId.hasPrefix("ses_debug")
    #else
      return false
    #endif
  }

  // MARK: - Reconcile

  /// Ends cards the gateway can no longer speak for: a wiped state dir, a host the user deleted, a
  /// session that finished while the phone was offline. Run on every foreground, because a card
  /// that outlives its turn is worse than no card - it claims work is happening that is not.
  nonisolated func reconcile() async {
    for activity in Activity<SessionActivityAttributes>.activities where activity.activityState == .active {
      let attributes = activity.attributes
      guard !Self.isLocallyRaised(attributes.sessionId) else { continue }
      guard let host = await hostFor(hostId: attributes.hostId), let client = host.makeClient() else {
        ActivityTrail.note("recon-end-nohost \(attributes.sessionId.prefix(8))")
        await activity.end(nil, dismissalPolicy: .immediate)
        continue
      }
      do {
        let info = try await client.getSession(id: attributes.sessionId)
        if info.status != .running && info.status != .awaitingApproval {
          ActivityTrail.note("recon-end-status \(attributes.sessionId.prefix(8)) \(info.status)")
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      } catch let error as WorkerClientError where error.statusCode == 404 {
        ActivityTrail.note("recon-end-404 \(attributes.sessionId.prefix(8))")
        await activity.end(nil, dismissalPolicy: .immediate)
      } catch {
        ActivityTrail.note("recon-skip-unreachable \(attributes.sessionId.prefix(8))")
        // Unreachable is not gone. `stale-date` already dims the card, and ending it here would
        // delete a live turn's card every time the tailnet hiccups.
        continue
      }
    }
  }

  private func hostFor(hostId: String?) -> Host? {
    guard let hosts else { return nil }
    return matching(hostId: hostId, in: hosts).first
  }

  /// The optimistic repaint an intent makes between the tap and the truth.
  nonisolated func paint(sessionId: String, hostId: String?, decision: String) async {
    for activity in Activity<SessionActivityAttributes>.activities
    where activity.attributes.sessionId == sessionId && (hostId == nil || activity.attributes.hostId == hostId) {
      var state = activity.content.state
      state.decision = decision
      await activity.update(ActivityContent(state: state, staleDate: nil))
    }
  }

  /// The card's own copy of the pending request, which is the only place an answer's original tool
  /// input can be read from: no REST route lists pending approvals.
  nonisolated func request(sessionId: String, hostId: String?) -> SessionActivityAttributes.Request? {
    Activity<SessionActivityAttributes>.activities
      .first { $0.attributes.sessionId == sessionId && (hostId == nil || $0.attributes.hostId == hostId) }?
      .content.state.request
  }
}
