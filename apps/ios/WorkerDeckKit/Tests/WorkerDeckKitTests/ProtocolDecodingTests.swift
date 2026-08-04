import Foundation
import Testing

@testable import WorkerDeckKit

@Suite("Protocol decoding")
struct ProtocolDecodingTests {
  private func decodeEvent(_ json: String) throws -> SessionEvent {
    try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
  }

  @Test func decodesStatusChanged() throws {
    let event = try decodeEvent(
      #"{"type":"status_changed","status":"awaiting_approval","seq":3,"ts":1722300000000}"#)
    #expect(event.seq == 3)
    #expect(event.body == .statusChanged(status: .awaitingApproval, detail: nil))
  }

  @Test func decodesAssistantMessageWithBlocks() throws {
    let event = try decodeEvent(
      #"""
      {"type":"assistant_message","seq":7,"ts":1722300000000,"uuid":"u1","parentToolUseId":null,
       "message":{"role":"assistant","content":[
         {"type":"text","text":"hello"},
         {"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"ls"}}]}}
      """#)
    guard case .assistantMessage(let payload) = event.body else {
      Issue.record("expected assistant_message, got \(event.body)")
      return
    }
    #expect(payload.uuid == "u1")
    #expect(payload.parentToolUseId == nil)
    #expect(
      payload.message.content.asBlocks == [
        .text("hello"),
        .toolUse(id: "tu1", name: "Bash", input: ["command": "ls"]),
      ])
  }

  @Test func decodesToolResultUserMessage() throws {
    let event = try decodeEvent(
      #"""
      {"type":"user_message","seq":8,"ts":1722300000000,"parentToolUseId":null,"synthetic":true,
       "message":{"role":"user","content":[
         {"type":"tool_result","tool_use_id":"tu1","is_error":false,
          "content":[{"type":"text","text":"file.txt"}]}]}}
      """#)
    guard case .userMessage(let payload) = event.body,
      case .toolResult(let block) = payload.message.content.asBlocks[0]
    else {
      Issue.record("expected user_message tool_result, got \(event.body)")
      return
    }
    #expect(block.toolUseId == "tu1")
    #expect(block.isError == false)
    #expect(block.content?.joinedText == "file.txt")
  }

  @Test func unknownEventTypeDegradesToUnknownNotError() throws {
    let event = try decodeEvent(
      #"{"type":"totally_new_event","seq":9,"ts":1722300000000,"stuff":{"a":1}}"#)
    guard case .unknown(let type, let raw) = event.body else {
      Issue.record("expected unknown, got \(event.body)")
      return
    }
    #expect(type == "totally_new_event")
    #expect(raw["stuff"]?["a"] == .number(1))
  }

  @Test func malformedKnownEventDegradesToUnknown() throws {
    // status_changed with a status value this mirror doesn't know.
    let event = try decodeEvent(
      #"{"type":"status_changed","status":"hibernating","seq":10,"ts":1722300000000}"#)
    guard case .unknown(let type, _) = event.body else {
      Issue.record("expected unknown fallback, got \(event.body)")
      return
    }
    #expect(type == "status_changed")
  }

  @Test func decodesRateLimitWithoutUtilization() throws {
    let event = try decodeEvent(
      #"{"type":"rate_limit","info":{"status":"allowed","rateLimitType":"five_hour"},"seq":11,"ts":1}"#)
    guard case .rateLimit(let info) = event.body else {
      Issue.record("expected rate_limit, got \(event.body)")
      return
    }
    // Absent utilization must decode as nil (unknown), never 0.
    #expect(info.utilization == nil)
    #expect(info.rateLimitType == "five_hour")
  }

  @Test func encodesPermissionDecisionCommand() throws {
    let command = SessionCommand.permissionDecision(
      requestId: "r1", behavior: .deny, message: "no", interrupt: true)
    let data = try JSONEncoder().encode(command)
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["type"] as? String == "permission_decision")
    #expect(object["requestId"] as? String == "r1")
    #expect(object["behavior"] as? String == "deny")
    #expect(object["interrupt"] as? Bool == true)
    #expect(object["updatedInput"] == nil)
  }

  @Test func encodesCreateSessionRequestOmittingNils() throws {
    let request = CreateSessionRequest(cwd: "/tmp/project", permissionMode: .plan)
    let data = try JSONEncoder().encode(request)
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["cwd"] as? String == "/tmp/project")
    #expect(object["permissionMode"] as? String == "plan")
    #expect(object.keys.contains("resume") == false)
    #expect(object.keys.contains("model") == false)
  }

  @Test func decodesAttachedFrame() throws {
    let json = #"""
      {"type":"attached","protocolVersion":4,"replayingFrom":0,
       "session":{"id":"s1","status":"idle","cwd":"/x","createdAt":1722300000000,
                  "lastSeq":12,"pendingPermissionCount":0}}
      """#
    let frame = try JSONDecoder().decode(ServerFrame.self, from: Data(json.utf8))
    guard case .attached(let attached) = frame else {
      Issue.record("expected attached, got \(frame)")
      return
    }
    #expect(attached.protocolVersion == WorkerProtocol.version)
    #expect(attached.session.id == "s1")
    #expect(attached.session.resolvedEngine == .claude)
  }
}
