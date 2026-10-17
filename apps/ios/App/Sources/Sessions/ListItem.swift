import Foundation
import WorkerDeckCore

// One drawn row: the core's display record.
struct ListItem: Identifiable {
  let row: ListRow

  var id: String { row.key }
  var sessionId: String { row.sessionId }
  var closed: Bool { row.sessionStatus == "closed" }
  var hostUUID: UUID? { UUID(uuidString: row.hostId) }
  var unseen: Int { Int(row.unseen) }
  var live: Bool { row.state == .working || row.state == .attention }
  var needsYou: Bool { row.state == .attention || row.teamState == .attention }
}

// One section of the list, in the core's order. A team's shown Members follow their lead at depth 1.
struct ListSection: Identifiable {
  let group: ListGroup
  let items: [ListItem]

  var id: String { group.key }
  var earlier: Bool { group.key == "earlier" }
}

extension ProjectChoice: @retroactive Identifiable {
  public var id: String { key }
}

extension ListStep: @retroactive Identifiable {
  public var id: String { "\(kind)-\(key)" }
}

extension SessionList {
  func sections(now: Double) -> [ListSection] {
    groups(nowMs: now).map { group in ListSection(group: group, items: group.rows.map(ListItem.init)) }
  }
}

// The `GET /v1/sessions` body for canned rollups, so a preview goes through the same core as the app.
enum ListFixture {
  static func body(_ sessions: [[String: Any]]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: ["sessions": sessions])) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }

  // A minimal valid rollup; `extra` overrides or adds fields in wire spelling.
  static func session(_ id: String, status: String = "idle", _ extra: [String: Any] = [:]) -> [String: Any] {
    var base: [String: Any] = [
      "id": id, "status": status, "cwd": "/Users/you/projects/workerdeck", "createdAt": 0, "lastSeq": 0,
      "pendingPermissionCount": 0,
    ]
    base.merge(extra) { _, new in new }
    return base
  }
}
