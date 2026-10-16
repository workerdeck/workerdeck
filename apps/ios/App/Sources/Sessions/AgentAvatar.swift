import SwiftUI
import UIKit
import WorkerDeckCore
import WorkerDeckKit

struct AgentAvatarFrames: Equatable {
  let still: UIImage
  let busy: [UIImage]
  let durations: [Double]
}

// The pictures the core list says to fetch (`avatarFetches`, keyed by gateway plus the seed-versioned
// `AgentRef.avatar`, retried a minute after a failure); this moves the bytes and slices the busy strip.
@MainActor
@Observable
final class AgentAvatarLoader {
  private var frames: [String: AgentAvatarFrames] = [:]

  func frames(hostId: String, agent: AgentRef?) -> AgentAvatarFrames? {
    guard let avatar = agent?.avatar else { return nil }
    return frames[avatarKey(hostId: hostId, avatar: avatar)]
  }

  func ensure(list: SessionList, clientFor: (String) -> WorkerClient?) {
    let now = Date().timeIntervalSince1970 * 1000
    for fetch in list.avatarFetches(nowMs: now) {
      guard let client = clientFor(fetch.hostId) else {
        list.avatarSettled(key: fetch.key, loaded: false, nowMs: now)
        continue
      }
      Task { [weak self] in
        let still = try? await client.fetch(Self.get(fetch.stillPath)).0
        let busy = try? await client.fetch(Self.get(fetch.busyPath))
        let image = still.flatMap(UIImage.init(data:))
        list.avatarSettled(key: fetch.key, loaded: image != nil, nowMs: Date().timeIntervalSince1970 * 1000)
        guard let image else { return }
        let durations = avatarFrameDurations(header: busy?.1.value(forHTTPHeaderField: "x-frame-durations"))
        let strip = busy.flatMap { Self.slice($0.0, durations) } ?? []
        self?.frames[fetch.key] = AgentAvatarFrames(still: image, busy: strip, durations: strip.isEmpty ? [] : durations)
      }
    }
  }

  private static func get(_ path: String) -> HttpCall { HttpCall(method: "GET", path: path, body: nil) }

  private static func slice(_ data: Data, _ durations: [Double]) -> [UIImage]? {
    guard let image = UIImage(data: data)?.cgImage,
      let width = avatarStripWidth(frames: UInt32(durations.count), imageWidth: UInt32(image.width)).map(Int.init)
    else { return nil }
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
    Int(avatarBusyFrame(durations: frames.durations, atMs: date.timeIntervalSinceReferenceDate * 1000))
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
