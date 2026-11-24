import Foundation
import WorkerDeckCore

// Where a row sits in a team block: the lead on top, Members under it on the tree line, the last one closing it.
enum NestRole {
  case lead
  case member
  case lastMember
}

// One drawn row: the core's display record.
struct ListItem: Identifiable {
  let row: ListRow
  var nest: NestRole?
  // One of its team block's rows is the selected one, so the block draws as one card.
  var teamSelected = false

  var id: String { row.key }
  var sessionId: String { row.sessionId }
  var closed: Bool { row.sessionStatus == "closed" }
  var hostUUID: UUID? { UUID(uuidString: row.hostId) }
  var unseen: Int { Int(row.unseen) }
  var live: Bool { row.state == .working || row.state == .attention }
  var needsYou: Bool { row.needsYou }
}

// What a section draws while a card drags: the cards but the dragged one, and the gap where it will land.
enum DrawnRow: Identifiable {
  case card(ListItem)
  case spacer(NestRole?)

  var id: String {
    switch self {
    case .card(let item): item.id
    case .spacer: "spacer"
    }
  }
}

extension ListSection {
  // The cards without `dragged`, the gap inserted at `target`'s slot when that lies in this section, nests re-derived.
  func drawn(dragged: String?, target: ListDragTarget?) -> [DrawnRow] {
    guard let dragged else { return items.map(DrawnRow.card) }
    var rows: [(item: ListItem?, depth: Int)] = items.filter { $0.id != dragged }.map { ($0, Int($0.row.depth)) }
    if let target {
      let lead = target.lane.hasPrefix("team:") ? String(target.lane.dropFirst(5)) : nil
      if let lead, let at = rows.firstIndex(where: { $0.item?.id == lead }) {
        var end = at + 1
        while end < rows.count, rows[end].depth > 0 { end += 1 }
        let place = rows[(at + 1)..<end].firstIndex { $0.item?.id == target.before } ?? end
        rows.insert((nil, 1), at: place)
      } else if lead == nil, target.lane == id {
        let place = rows.firstIndex { $0.depth == 0 && $0.item?.id == target.before } ?? rows.count
        rows.insert((nil, 0), at: place)
      }
    }
    return rows.indices.map { at in
      let nested = at + 1 < rows.count && rows[at + 1].depth > 0
      let nest: NestRole? = rows[at].depth > 0 ? (nested ? .member : .lastMember) : (nested ? .lead : nil)
      guard var item = rows[at].item else { return .spacer(nest) }
      item.nest = nest
      return .card(item)
    }
  }
}

// One section of the list, in the core's order. A team's shown Members follow their lead at depth 1.
struct ListSection: Identifiable {
  let group: ListGroup
  let items: [ListItem]

  var id: String { group.key }
  var earlier: Bool { group.earlier }
}

extension ProjectChoice: @retroactive Identifiable {
  public var id: String { key }
}

extension ListStep: @retroactive Identifiable {
  public var id: String { "\(kind)-\(key)" }
}

extension SessionList {
  func sections(now: Double) -> [ListSection] {
    groups(nowMs: now).map { group in
      let rows = group.rows
      var items = rows.indices.map { at in
        let next = at + 1 < rows.count ? rows[at + 1] : nil
        let nested = (next?.depth ?? 0) > 0
        let nest: NestRole? =
          rows[at].depth > 0 ? (nested ? .member : .lastMember) : (nested ? .lead : nil)
        return ListItem(row: rows[at], nest: nest)
      }
      var start = 0
      for at in items.indices where items[at].nest == nil || items[at].nest == .lastMember {
        if items[start...at].contains(where: { $0.row.selected && $0.nest != nil }) {
          for i in start...at { items[i].teamSelected = true }
        }
        start = at + 1
      }
      return ListSection(group: group, items: items)
    }
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
