import Foundation

/// Which vendor's mark a session wears — a 1:1 port of `engineMark` in
/// `packages/ui/src/components/agent/EngineIcon.tsx`.
///
/// The two first-party engines are named directly. A `provider` session is
/// whatever the host wired up, so its *model* is the only thing that says whose
/// it is — sniffed loosely on purpose (`gemini-2.5-pro`, `deepseek-chat`,
/// `kimi-k2`), and falling through to `nil` rather than guessing wrong.
///
/// **A port, and it has to stay one**, for the same reason `friendlyModel` is:
/// the mark and the model name sit next to each other on a sessions row, and a
/// row that drew OpenAI's mark beside a name the sidebar spells as Gemini's
/// would be worse than drawing no mark at all. It lives in the kit rather than
/// the app so `swift test` can reach it — this is a rule with edges, and the
/// edges are where a sniffer goes wrong.
///
/// The returned key is also the asset name's suffix: `EngineClaude`,
/// `EngineCodex`, … generated into the catalog by
/// `apps/ios/scripts/gen-engine-marks.mjs` from the very same table this
/// mirrors.
public enum EngineMark: String, Sendable, CaseIterable {
  case claude
  case codex
  case gemini
  case deepseek
  case moonshot

  /// The asset-catalog name of this mark's vector.
  public var assetName: String { "Engine\(rawValue.prefix(1).uppercased())\(rawValue.dropFirst())" }
}

public func engineMark(engine: String, model: String?) -> EngineMark? {
  if engine == "claude" { return .claude }
  if engine == "codex" { return .codex }
  let id = model?.lowercased() ?? ""
  if id.isEmpty { return nil }
  if id.contains("gemini") { return .gemini }
  if id.contains("deepseek") { return .deepseek }
  if id.contains("moonshot") || id.contains("kimi") { return .moonshot }
  if id.contains("claude") { return .claude }
  if id.hasPrefix("gpt") || id.hasPrefix("o1") || id.hasPrefix("o3") || id.contains("openai") {
    return .codex
  }
  return nil
}

/// How far the vendor's colour reaches — a port of `VENDOR_MARK` / `VENDOR_TEXT`
/// beside `engineMark` on the web.
///
/// The mark and the model name are coloured separately, and deliberately not
/// symmetrically: coral is Anthropic's accent, while OpenAI's guidelines forbid
/// adding colour to the mark at all, so theirs is pure white/black. At full
/// contrast that is right on a 12px glyph and wrong on an 11px label — a
/// pure-white model name outweighs the session title above it, inverting the
/// row's hierarchy to say something the mark has already said. So OpenAI's name
/// stays secondary, which is also the most literal reading of "don't add any
/// colors".
extension EngineMark {
  /// Whether the mark itself wears the vendor colour. Every vendor with a token
  /// does; the rest fall through to the row's secondary foreground.
  public var tintsMark: Bool {
    switch self {
    case .claude, .codex: return true
    case .gemini, .deepseek, .moonshot: return false
    }
  }

  /// Whether the model *name* beside it does. See the note above on why this is
  /// not the same set.
  public var tintsName: Bool {
    switch self {
    case .claude: return true
    case .codex, .gemini, .deepseek, .moonshot: return false
    }
  }
}
