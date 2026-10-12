import SwiftUI
import UIKit
import WorkerDeckKit

struct AgentAvatarFrames: Equatable {
  let still: UIImage
  let busy: [UIImage]
  let durations: [Double]

  var busyPeriod: Double { durations.reduce(0, +) }
}

// Keyed by gateway plus `AgentRef.avatar`, which is versioned by the avatar's seed, so each picture is fetched once.
@MainActor
@Observable
final class AgentAvatarLoader {
  private static let retryAfter: TimeInterval = 60

  private var frames: [String: AgentAvatarFrames] = [:]
  private var inFlight: Set<String> = []
  private var failedAt: [String: Date] = [:]

  func frames(hostId: String, agent: AgentRef?) -> AgentAvatarFrames? {
    guard let agent, let path = agent.avatar else { return nil }
    return frames[Self.key(hostId, path)]
  }

  func ensure(hostId: String, agent: AgentRef?, client: WorkerClient?) {
    guard let agent, let path = agent.avatar, let client else { return }
    let key = Self.key(hostId, path)
    if frames[key] != nil || inFlight.contains(key) { return }
    if let failed = failedAt[key], Date().timeIntervalSince(failed) < Self.retryAfter { return }
    inFlight.insert(key)
    let agentId = agent.id
    Task { [weak self] in
      defer { self?.inFlight.remove(key) }
      do {
        let still = try await client.agentAvatar(id: agentId)
        let busy = try? await client.agentAvatar(id: agentId, busy: true)
        guard let image = UIImage(data: still.data) else {
          self?.failedAt[key] = Date()
          return
        }
        let strip = busy.flatMap { Self.slice($0) } ?? []
        self?.failedAt[key] = nil
        self?.frames[key] = AgentAvatarFrames(
          still: image, busy: strip, durations: strip.isEmpty ? [] : busy?.durations ?? [])
      } catch {
        self?.failedAt[key] = Date()
      }
    }
  }

  private static func key(_ hostId: String, _ path: String) -> String { "\(hostId)|\(path)" }

  private static func slice(_ strip: AgentAvatarImage) -> [UIImage]? {
    guard let durations = strip.durations, durations.count > 1,
      let image = UIImage(data: strip.data)?.cgImage
    else { return nil }
    let width = image.width / durations.count
    guard width > 0 else { return nil }
    let frames = (0..<durations.count).compactMap { index in
      image.cropping(to: CGRect(x: index * width, y: 0, width: width, height: image.height))
        .map { UIImage(cgImage: $0) }
    }
    return frames.count == durations.count ? frames : nil
  }
}

struct AgentAvatarView: View {
  let info: SessionInfo
  let frames: AgentAvatarFrames?
  var size: CGFloat = 32
  var state: SessionState?
  var badge = true

  private var shown: SessionState { state ?? sessionState(info) }
  private var asleep: Bool { info.engineAsleep == true }
  private var corner: CGFloat { size >= 28 ? 14 : 11 }

  var body: some View {
    picture
      .frame(width: size, height: size)
      .overlay(alignment: .bottomTrailing) {
        if badge, shown != .idle || asleep {
          SessionStatusIcon(session: info, state: shown)
            .font(.system(size: corner * 0.7))
            .frame(width: corner, height: corner)
            .background(Circle().fill(Color(.systemBackground)))
            .offset(x: 4, y: 4)
        }
      }
      .accessibilityLabel(info.agent?.name ?? "Session")
  }

  @ViewBuilder
  private var picture: some View {
    if let frames, shown == .working, !frames.busy.isEmpty, !asleep {
      TimelineView(.animation) { timeline in
        pixelated(frames.busy[busyFrame(frames, at: timeline.date)])
      }
    } else if let frames {
      pixelated(frames.still)
        .saturation(asleep ? 0 : 1)
        .opacity(asleep ? 0.6 : 1)
    } else {
      RoundedRectangle(cornerRadius: 4)
        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        .foregroundStyle(.tertiary)
        .overlay {
          EngineIconView(
            engine: info.engine?.rawValue ?? "claude", model: info.model, size: size / 2)
        }
    }
  }

  private func pixelated(_ image: UIImage) -> some View {
    Image(uiImage: image)
      .interpolation(.none)
      .resizable()
      .clipShape(RoundedRectangle(cornerRadius: 4))
  }

  private func busyFrame(_ frames: AgentAvatarFrames, at date: Date) -> Int {
    let period = frames.busyPeriod
    guard period > 0 else { return 0 }
    var at = (date.timeIntervalSinceReferenceDate * 1000).truncatingRemainder(dividingBy: period)
    for (index, duration) in frames.durations.enumerated() {
      if at < duration { return index }
      at -= duration
    }
    return frames.durations.count - 1
  }
}

struct LeadChip: View {
  var body: some View {
    Text("LEAD")
      .font(.system(size: 9, weight: .semibold))
      .tracking(0.6)
      .foregroundStyle(.tint)
      .padding(.horizontal, 4)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(.tint.opacity(0.5), lineWidth: 1))
  }
}

struct AgentHeadingView: View {
  let info: SessionInfo
  let frames: AgentAvatarFrames?

  var body: some View {
    if let agent = info.agent {
      HStack(spacing: 8) {
        AgentAvatarView(info: info, frames: frames, size: 24)
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 6) {
            Text(agent.name).font(.headline).lineLimit(1)
            if agent.isLead { LeadChip() }
          }
          Text(detail(agent)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
      }
    }
  }

  private func detail(_ agent: AgentRef) -> String {
    let team = agent.lead != nil ? agent.team.map { "\($0) team" } : nil
    return [team, "conversation \(agent.conversation ?? 1)"].compactMap { $0 }.joined(
      separator: " · ")
  }
}
