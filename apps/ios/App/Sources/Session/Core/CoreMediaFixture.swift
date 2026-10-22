import Foundation
import UIKit

// Two small sessions for the core preview (`UIPREVIEW_CORE=media|empty`), answered in-process: a result picture, a
// codex host-path picture, a truncated result whose full text the "fetch" press brings, and a running Bash call the
// row menu can move to the background. `empty` is a fresh session with nothing said yet.
enum CoreMediaFixture {
  static let fullLine = "full output line 120 of the build log"
  static let codexPath = "/work/fixture/diagram.png"

  // Fresh on every launch, so a test always starts with nothing bookmarked.
  @MainActor static let bookmarks: BookmarkModel = {
    let defaults = UserDefaults(suiteName: "uipreview.core") ?? .standard
    defaults.removePersistentDomain(forName: "uipreview.core")
    return BookmarkModel(defaults: defaults)
  }()

  static func frames(_ variant: String) -> [String]? {
    switch variant {
    case "media": return [attached(lastSeq: media.count)] + media
    case "empty": return [attached(lastSeq: 0)]
    default: return nil
    }
  }

  private static func attached(lastSeq: Int) -> String {
    #"{"type":"attached","protocolVersion":2,"replayingFrom":0,"shell":true,"session":{"id":"fixture","title":"Media fixture","status":"idle","cwd":"/work/fixture","createdAt":1,"lastSeq":\#(lastSeq),"conversation":1,"sdkSessionId":"sdk-fixture","pendingPermissionCount":0,"capabilities":{"interactiveApprovals":false,"permissionModes":[],"defaultPermissionMode":"default","resume":false,"resumeBackfill":false,"listSessions":false,"contextUsage":false,"mcpStatus":false,"mcpServerActions":false,"sessionMcpServers":false,"toolFilters":"none","settingSources":false,"budgets":false,"vfs":false,"streaming":"none","attachments":[],"slashCommands":false,"skillsList":false,"rateLimits":false,"backgroundTasks":true,"engineSleep":true}}}"#
  }

  private static var media: [String] {
    let bodies = [
      #""type":"user_message","message":{"role":"user","content":"Show me the screenshot and the build log."},"parentToolUseId":null,"uuid":"u-1""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_read","name":"Read","input":{"file_path":"/work/fixture/shot.png"}}]},"parentToolUseId":null,"uuid":"a-1""#,
      #""type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_read","content":[{"type":"image_ref","media_type":"image/png","bytes":2048,"part_index":0}]}]},"parentToolUseId":null,"synthetic":true,"uuid":"toolu_read:result""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"That is the screenshot."}]},"parentToolUseId":null,"uuid":"t-1""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_log","name":"Bash","input":{"command":"cat build.log"}}]},"parentToolUseId":null,"uuid":"a-2""#,
      #""type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_log","content":"head line 1\nhead line 2","truncated":true,"total_chars":9000}]},"parentToolUseId":null,"synthetic":true,"uuid":"toolu_log:result""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"That is the log head."}]},"parentToolUseId":null,"uuid":"t-2""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_codex","name":"CodexImageView","input":{"path":"\#(codexPath)"}}]},"parentToolUseId":null,"uuid":"a-3""#,
      #""type":"user_message","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_codex","content":"viewed"}]},"parentToolUseId":null,"synthetic":true,"uuid":"toolu_codex:result""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"text","text":"Here is what I found."}]},"parentToolUseId":null,"uuid":"r-1""#,
      #""type":"assistant_message","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_long","name":"Bash","input":{"command":"npm run watch"}}]},"parentToolUseId":null,"uuid":"a-4""#,
    ]
    return bodies.enumerated().map { index, body in
      let seq = index + 1
      return #"{"type":"event","event":{"# + body + #","seq":\#(seq),"ts":\#(1_760_000_000_000 + seq * 1000)}}"#
    }
  }

  static func respond(_ method: String, _ path: String) -> (UInt16, String)? {
    guard method == "GET", path.contains("/result?toolUseId=toolu_log") else { return nil }
    let lines = (1...120).map { $0 == 120 ? fullLine : "full output line \($0)" }.joined(separator: "\\n")
    return (200, #"{"content":"\#(lines)"}"#)
  }

  // A picture's bytes by the path the core named: `/fs/read` answers the gateway's JSON, anything else raw PNG.
  static func image(at path: String) throws -> Data {
    let png = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 200)).pngData { context in
      UIColor.systemTeal.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 320, height: 200))
      UIColor.systemOrange.setFill()
      context.cgContext.fillEllipse(in: CGRect(x: 110, y: 50, width: 100, height: 100))
    }
    guard path.hasPrefix("/fs/read") else { return png }
    return try JSONSerialization.data(withJSONObject: ["encoding": "base64", "content": png.base64EncodedString()])
  }
}
