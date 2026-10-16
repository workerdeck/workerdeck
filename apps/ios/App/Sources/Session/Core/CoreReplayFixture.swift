import Foundation

// A long session as gateway frames, for driving the core preview with no gateway: each turn is a prompt, a Bash call
// whose output is long enough to fold, and a markdown answer. Turn `taskTurn` hands its work to a sub-agent instead,
// whose `agentSteps` Bash steps scroll in its takeover; step `failedStep` fails, so its rail has a mark.
enum CoreReplayFixture {
  static let turns = 60
  static let outputLines = 30
  static let taskTurn = 56
  static let taskId = "toolu_task"
  static let taskDescription = "Survey every batch"
  static let agentSteps = 40
  static let failedStep = 25

  static var frames: [String] {
    var seq = 0
    var events: [String] = []
    func event(_ body: String) {
      seq += 1
      events.append(#"{"type":"event","event":{"#+body+#","seq":\#(seq),"ts":\#(1_760_000_000_000 + seq * 1000)}}"#)
    }
    event(#""type":"status_changed","status":"running""#)
    func agent(_ body: String) { event(body + #","parentToolUseId":"\#(taskId)""#) }
    func taskTurnEvents(_ turn: Int) {
      event(
        #""type":"user_message","message":{"role":"user","content":"Turn \#(turn): survey the batches with a sub-agent."},"parentToolUseId":null,"uuid":"u-\#(turn)""#
      )
      event(
        #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"\#(taskId)","name":"Task","input":{"description":"\#(taskDescription)","prompt":"Count the files in every batch."}}]},"parentToolUseId":null,"uuid":"a-\#(turn)""#
      )
      for step in 1...agentSteps {
        agent(
          #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_step_\#(step)","name":"Bash","input":{"command":"agent step \#(step)"}}]},"uuid":"as-\#(step)""#
        )
        let failed = step == failedStep ? #","is_error":true"# : ""
        agent(
          #""type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_step_\#(step)","content":"step \#(step) done"\#(failed)}]},"synthetic":true,"uuid":"toolu_step_\#(step):result""#
        )
      }
      agent(
        #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"Every batch surveyed."}]},"uuid":"as-done""#
      )
      event(
        #""type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"\#(taskId)","content":"Every batch surveyed."}]},"parentToolUseId":null,"synthetic":true,"uuid":"\#(taskId):result""#
      )
      event(
        #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"The sub-agent surveyed every batch."}]},"parentToolUseId":null,"uuid":"r-\#(turn)""#
      )
    }
    for turn in 1...turns {
      if turn == taskTurn {
        taskTurnEvents(turn)
        continue
      }
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
    event(
      ##""type":"context_usage","usage":{"totalTokens":124000,"maxTokens":200000,"percentage":62,"model":"claude-opus-4-6","categories":[{"name":"Messages","tokens":98000,"color":"#497eae"},{"name":"System tools","tokens":26000,"color":"inactive"}]}"##
    )
    event(#""type":"rate_limit","info":{"status":"allowed","rateLimitType":"five_hour","utilization":34}"#)
    event(#""type":"rate_limit","info":{"status":"allowed","rateLimitType":"seven_day","utilization":83}"#)
    event(#""type":"status_changed","status":"idle""#)
    let attached =
      #"{"type":"attached","protocolVersion":1,"replayingFrom":0,"acks":true,"shell":true,"session":{"id":"fixture","title":"Core fixture","status":"idle","cwd":"/work/fixture","createdAt":1,"profile":"fixture","totalCostUsd":1.84,"costUsd":1.62,"usageByModel":{"claude-opus-4-6":{"input":120000,"output":30000,"cacheWrite5m":0,"cacheWrite1h":0,"cacheRead":900000}},"lastSeq":\#(seq),"pendingPermissionCount":0}}"#
    return [attached] + events
  }

  // One running shell behind the last row, answered here instead of by a gateway: its attach replays a numbered
  // scrollback, typed input echoes, and Enter prints a listing and a fresh prompt.
  static let shellId = "sh_fixture"
  static let shellCommand = "npm run dev"
  static let scrollback = 80

  private static func shellRecord(
    _ status: String, id: String = shellId, command: String = shellCommand, ended: String = #""endReason":"killed","#
  ) -> String {
    let ended = status == "exited" ? ended : ""
    return
    #"{"id":"\#(id)","sessionId":"fixture","ordinal":1,"command":"\#(command)","label":"\#(command)","cwd":"/work/fixture","owner":"user","status":"\#(status)",\#(ended)"startedAt":1,"bytes":0,"cols":80,"rows":24}"#
  }

  // A composer `$` command lands as one more shell row, exited at once, numbered after the replay.
  static let ranOutput = "ran-ok"
  private static let seq = Counter(frames.count - 1)

  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int
    init(_ value: Int) { self.value = value }
    func next() -> Int {
      lock.lock()
      defer { lock.unlock() }
      value += 1
      return value
    }
  }

  private static func ran(_ command: String) -> String {
    let seq = seq.next()
    let quoted = (try? JSONSerialization.data(withJSONObject: [command], options: .fragmentsAllowed))
      .flatMap { String(data: $0, encoding: .utf8) }.map { String($0.dropFirst(2).dropLast(2)) } ?? command
    let record = shellRecord("exited", id: "sh_run_\(seq)", command: quoted, ended: #""exitCode":0,"endReason":"exit","#)
    return
      #"{"type":"event","event":{"type":"user_message","message":{"role":"user","content":"<local-command-stdout>$ \#(quoted)\n\#(ranOutput)</local-command-stdout>"},"parentToolUseId":null,"synthetic":true,"shell":\#(record),"uuid":"sh-run-\#(seq)","seq":\#(seq),"ts":\#(1_760_000_000_000 + seq * 1000)}}"#
  }

  // The account's own reading for the fixture's profile: fresh, so it wins the weekly window over the replay's.
  private static var profiles: String {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    let resets = Int(Date().timeIntervalSince1970) + 2 * 86_400
    return
      #"{"profiles":[{"name":"fixture","usage":{"seven_day":{"info":{"status":"allowed","utilization":71,"resetsAt":\#(resets)},"updatedAt":\#(now)},"seven_day_opus":{"info":{"status":"allowed","utilization":12},"updatedAt":\#(now)}},"spend":{"weekUsd":41.2,"monthUsd":160,"weekByModel":{},"unpricedShare":0,"subscription":{"weeklyUsd":41.2,"monthlyUsd":200,"weeklyShareUsd":46.15,"ratio":0.89}}}]}"#
  }

  static func respond(_ method: String, _ path: String) -> (UInt16, String) {
    switch (method, path) {
    case ("GET", "/shells/\(shellId)"): return (200, #"{"shell":\#(shellRecord("running"))}"#)
    case ("POST", "/shells/\(shellId)/kill"): return (200, #"{"shell":\#(shellRecord("exited"))}"#)
    case ("GET", "/profiles"): return (200, profiles)
    default: return (404, "")
    }
  }

  static func replies(to sent: String) -> [String] {
    guard let data = sent.data(using: .utf8),
      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [] }
    if frame["type"] as? String == "shell_command", let command = frame["command"] as? String {
      return [ran(command)]
    }
    guard frame["shellId"] as? String == shellId else { return [] }
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
