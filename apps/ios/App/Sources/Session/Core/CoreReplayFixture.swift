#if WD_NATIVE_CORE
import Foundation

// A long session as gateway frames, for driving the core preview with no gateway: each turn is a prompt, a Bash call
// whose output is long enough to fold, and a markdown answer.
enum CoreReplayFixture {
  static let turns = 60
  static let outputLines = 30

  static var frames: [String] {
    var seq = 0
    var events: [String] = []
    func event(_ body: String) {
      seq += 1
      events.append(#"{"type":"event","event":{"#+body+#","seq":\#(seq),"ts":\#(1_760_000_000_000 + seq * 1000)}}"#)
    }
    event(#""type":"status_changed","status":"running""#)
    for turn in 1...turns {
      event(
        #""type":"user_message","message":{"role":"user","content":"Turn \#(turn): count the files in batch \#(turn)."},"parentToolUseId":null,"uuid":"u-\#(turn)""#
      )
      event(
        #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_\#(turn)","name":"Bash","input":{"command":"ls batch-\#(turn)"}}]},"parentToolUseId":null,"uuid":"a-\#(turn)""#
      )
      let output = (1...outputLines).map { "output line \($0) of turn \(turn)" }.joined(separator: "\\n")
      event(
        #""type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_\#(turn)","content":"\#(output)"}]},"parentToolUseId":null,"synthetic":true,"uuid":"toolu_\#(turn):result""#
      )
      event(
        #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"Batch \#(turn) holds **\#(outputLines) files**, *all* of them plain."}]},"parentToolUseId":null,"uuid":"r-\#(turn)""#
      )
    }
    event(
      #""type":"user_message","message":{"role":"user","content":"<local-command-stdout>$ \#(shellCommand)\nready</local-command-stdout>"},"parentToolUseId":null,"synthetic":true,"shell":\#(shellRecord("running")),"uuid":"sh-row""#
    )
    event(#""type":"status_changed","status":"idle""#)
    let attached =
      #"{"type":"attached","protocolVersion":1,"replayingFrom":0,"acks":true,"session":{"id":"fixture","title":"Core fixture","status":"idle","cwd":"/work/fixture","createdAt":1,"lastSeq":\#(seq),"pendingPermissionCount":0}}"#
    return [attached] + events
  }

  // One running shell behind the last row, answered here instead of by a gateway: its attach replays a numbered
  // scrollback, typed input echoes, and Enter prints a listing and a fresh prompt.
  static let shellId = "sh_fixture"
  static let shellCommand = "npm run dev"
  static let scrollback = 80

  private static func shellRecord(_ status: String) -> String {
    let ended = status == "exited" ? #""endReason":"killed","# : ""
    return
    #"{"id":"\#(shellId)","sessionId":"fixture","ordinal":1,"command":"\#(shellCommand)","label":"\#(shellCommand)","cwd":"/work/fixture","owner":"user","status":"\#(status)",\#(ended)"startedAt":1,"bytes":0,"cols":80,"rows":24}"#
  }

  static func respond(_ method: String, _ path: String) -> (UInt16, String) {
    switch (method, path) {
    case ("GET", "/shells/\(shellId)"): return (200, #"{"shell":\#(shellRecord("running"))}"#)
    case ("POST", "/shells/\(shellId)/kill"): return (200, #"{"shell":\#(shellRecord("exited"))}"#)
    default: return (404, "")
    }
  }

  static func replies(to sent: String) -> [String] {
    guard let data = sent.data(using: .utf8),
      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      frame["shellId"] as? String == shellId
    else { return [] }
    switch frame["type"] as? String {
    case "shell_attach":
      let lines = (1...scrollback).map { String(format: "boot %03d", $0) }.joined(separator: "\r\n")
      return [
        json([
          "type": "shell_attached", "shellId": shellId, "shell": record("running"),
          "cols": frame["cols"] ?? 80, "rows": frame["rows"] ?? 24, "scrollback": lines + "\r\n$ ",
        ])
      ]
    case "shell_input":
      let echo = (frame["data"] as? String ?? "")
        .replacingOccurrences(of: "\u{7f}", with: "\u{8} \u{8}")
        .replacingOccurrences(of: "\r", with: "\r\nfile-a  file-b  file-c\r\n$ ")
      return [json(["type": "shell_output", "shellId": shellId, "data": echo])]
    default:
      return []
    }
  }

  private static func record(_ status: String) -> Any {
    (try? JSONSerialization.jsonObject(with: Data(shellRecord(status).utf8))) ?? [:]
  }

  private static func json(_ object: [String: Any]) -> String {
    (try? JSONSerialization.data(withJSONObject: object)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
  }
}
#endif
