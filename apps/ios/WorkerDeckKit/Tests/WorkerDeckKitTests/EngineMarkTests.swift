import Testing

@testable import WorkerDeckKit

/// The port's fidelity is the point: a sniffer's edges are where it goes wrong,
/// and a row that drew OpenAI's mark beside a name the sidebar spells as
/// Gemini's would be worse than drawing no mark at all. These are the cases
/// `engineMark`'s TS doc comment names, so a drift in either direction fails
/// here rather than shipping as a mismatched glyph.
@Suite("engineMark")
struct EngineMarkTests {
  @Test("the two first-party engines are named, never sniffed")
  func firstParty() {
    #expect(engineMark(engine: "claude", model: nil) == .claude)
    #expect(engineMark(engine: "codex", model: nil) == .codex)
    // The engine wins over the model — a codex session pointed at a Gemini id
    // is still OpenAI's process.
    #expect(engineMark(engine: "codex", model: "gemini-2.5-pro") == .codex)
  }

  @Test("a provider session is sniffed from its model, loosely and on purpose")
  func provider() {
    #expect(engineMark(engine: "provider", model: "gemini-2.5-pro") == .gemini)
    #expect(engineMark(engine: "provider", model: "deepseek-chat") == .deepseek)
    #expect(engineMark(engine: "provider", model: "kimi-k2") == .moonshot)
    #expect(engineMark(engine: "provider", model: "moonshot-v1-8k") == .moonshot)
    #expect(engineMark(engine: "provider", model: "claude-opus-5[1m]") == .claude)
    #expect(engineMark(engine: "provider", model: "gpt-5.6-luna") == .codex)
    #expect(engineMark(engine: "provider", model: "o3-mini") == .codex)
    #expect(engineMark(engine: "provider", model: "openai/gpt-4o") == .codex)
    // Case is not the caller's problem.
    #expect(engineMark(engine: "provider", model: "GPT-5") == .codex)
  }

  @Test("no mark rather than a wrong one")
  func unknown() {
    #expect(engineMark(engine: "provider", model: nil) == nil)
    #expect(engineMark(engine: "provider", model: "") == nil)
    #expect(engineMark(engine: "provider", model: "llama-3.1-70b") == nil)
    // `gpt` is a *prefix* test, not a substring one: an unrelated id that merely
    // contains the letters must not be claimed.
    #expect(engineMark(engine: "provider", model: "mygptmodel") == nil)
  }

  @Test("the asset name is the catalog's, so the generator and the view agree")
  func assetNames() {
    #expect(EngineMark.claude.assetName == "EngineClaude")
    #expect(EngineMark.codex.assetName == "EngineCodex")
    #expect(EngineMark.deepseek.assetName == "EngineDeepseek")
  }

  /// Colour reaches the mark for both branded vendors and the *name* for only
  /// one — OpenAI's guidelines forbid adding colour to the mark, so theirs is at
  /// full contrast, which is right on a glyph and wrong on an 11pt label.
  @Test("the vendor colour reaches the mark further than it reaches the name")
  func tintReach() {
    #expect(EngineMark.claude.tintsMark)
    #expect(EngineMark.claude.tintsName)
    #expect(EngineMark.codex.tintsMark)
    #expect(!EngineMark.codex.tintsName)
    #expect(!EngineMark.gemini.tintsMark)
  }
}
