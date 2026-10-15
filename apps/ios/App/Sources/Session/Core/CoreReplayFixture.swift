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
    event(#""type":"status_changed","status":"idle""#)
    let attached =
      #"{"type":"attached","protocolVersion":1,"replayingFrom":0,"acks":true,"session":{"id":"fixture","title":"Core fixture","status":"idle","cwd":"/work/fixture","createdAt":1,"lastSeq":\#(seq),"pendingPermissionCount":0}}"#
    return [attached] + events
  }
}
#endif
