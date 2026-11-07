import SwiftUI
import WorkerDeckCore

struct LeadFleet {
  let members: () -> [FleetMember]
  let open: (FleetMember) -> Void
  let refresh: () -> Void
}

struct CoreFleetStrip: View {
  let fleet: LeadFleet
  let retry: (FleetMember, Int64) -> Void

  var body: some View {
    let members = fleet.members()
    if !members.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(members, id: \.key) { row($0) }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .overlay(alignment: .bottom) { Divider() }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("fleet-strip")
    }
  }

  private func row(_ member: FleetMember) -> some View {
    HStack(spacing: 8) {
      Button { fleet.open(member) } label: {
        HStack(spacing: 6) {
          face(member)
          Text(member.name).foregroundStyle(.primary).lineLimit(1).fixedSize()
          ReasonChipsView(reasons: member.reasons)
          Text(member.text).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 0)
        }
        .font(.caption)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open \(member.name)")
      if let n = member.retry {
        Button("Retry start") { retry(member, Int64(n)) }.buttonStyle(.bordered).controlSize(.small)
      }
    }
  }

  @ViewBuilder
  private func face(_ member: FleetMember) -> some View {
    if let face = member.face {
      FaceView(spec: face, size: 16)
    } else {
      RoundedRectangle(cornerRadius: 4)
        .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
        .foregroundStyle(.tertiary)
        .frame(width: 16, height: 16)
    }
  }
}
