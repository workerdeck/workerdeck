import Foundation

/// The human-readable label a tool row shows instead of its wire name.
///
/// Mirrors `@workerdeck/protocol`'s `tool-titles.ts`. A title is only ever
/// *declared* - by an MCP server, or by the built-in table below - and never
/// invented from the wire name: a name nothing has a title for is shown as it
/// came off the wire, because a guessed sentence is worse than a symbol the
/// reader can search for.
public enum ToolTitles {
  public static let maxChars = 64

  /// Capability tools the sandbox grants and the synthetic names the codex
  /// adapter invents: wire names with no public vocabulary behind them. An
  /// engine's own tool names (`Bash`, `Read`, `Task`) are deliberately absent -
  /// those are the CLI's published names and users read them.
  public static let builtin: [String: String] = [
    "fs_read": "Reading a file",
    "fs_write": "Writing a file",
    "fs_list": "Listing files",
    "eval_script": "Running a script",
    "web_fetch": "Fetching a web page",
    "web_search": "Searching the web",
    "deliver_file": "Delivering a file",
    "download": "Downloading a file",
    "CodexCommand": "Running a command",
    "CodexFileChange": "Editing a file",
    "CodexWebSearch": "Searching the web",
    "CodexImageGeneration": "Generating an image",
    "CodexImageView": "Viewing an image",
    "peers_list": "Listing peer sessions",
    "peers_peek": "Peeking at a peer session",
    "peers_send": "Messaging a peer session",
    "mcp__workerdeck__peers_list": "Listing peer sessions",
    "mcp__workerdeck__peers_peek": "Peeking at a peer session",
    "mcp__workerdeck__peers_send": "Messaging a peer session",
  ]

  /// The peer tools both engines expose, under the bare name and the
  /// MCP-prefixed one. Mirrors protocol's `PEER_SEND_TOOLS`.
  public static let peerSendTools: Set<String> = ["peers_send", "mcp__workerdeck__peers_send"]

  /// Declared title → built-in table → nothing.
  public static func title(for name: String, titles: [String: String]? = nil) -> String? {
    sanitize(titles?[name] ?? builtin[name], name: name)
  }

  /// Titles reach here from remote MCP servers, so they are untrusted display
  /// text: one line, clamped, and never a restatement of the wire name the
  /// caller already has.
  public static func sanitize(_ title: String?, name: String? = nil) -> String? {
    guard let title else { return nil }
    var flat = ""
    var pendingSpace = false
    for scalar in title.unicodeScalars {
      if scalar.value <= 0x1f || scalar.value == 0x7f || scalar.properties.isWhitespace {
        pendingSpace = !flat.isEmpty
        continue
      }
      if pendingSpace {
        flat.unicodeScalars.append(" ")
        pendingSpace = false
      }
      flat.unicodeScalars.append(scalar)
    }
    if flat.isEmpty || flat == name { return nil }
    guard flat.count > maxChars else { return flat }
    return String(flat.prefix(maxChars - 1)) + "…"
  }
}

/// Is this call a message to another session? A client that draws peer traffic
/// as its own kind of row has to recognise the call by name.
public func isPeerSendTool(_ name: String) -> Bool {
  ToolTitles.peerSendTools.contains(name)
}
