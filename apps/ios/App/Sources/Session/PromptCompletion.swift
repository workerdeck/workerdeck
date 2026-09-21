import WorkerDeckKit
import Foundation
import Observation

/// Drives the suggestion list under the composer, for all three prompt tokens.
///
/// The text half - finding and replacing a token - is `PromptTokens` in
/// `WorkerDeckKit`, where it can be unit-tested; this is the part that needs a
/// client, a clock, and the session's capabilities.
///
/// They behave nothing alike, which is why they share a model rather than a code
/// path. `/` offers commands *and* skills in one ranked list - commands arrive
/// with the `capabilities` event and skills with the `skills` event, so filtering
/// both is local, synchronous and complete - and what a picked skill *inserts* is
/// still codex's `$name`, which is the token the model reads. `#sessions` are the
/// other sessions on this gateway, polled slowly because a name is not a reading.
/// `@files` are a search
/// against the host filesystem: debounced and single-flight, so a fast typist
/// makes one request rather than eight, and a gateway without host files answers
/// 404 once and file completion switches itself off for the session rather than
/// asking again on every character.
@MainActor
@Observable
final class PromptCompletionModel {
  enum Suggestion: Identifiable, Equatable {
    case file(HostFileMatch)
    case command(SlashCommandInfo)
    /// A skill, offered on `/` beside commands. Resolves to prose, not to a
    /// token: see `SkillInfo`, no engine parses `$skillname` as syntax.
    case skill(SkillInfo)
    /// Another session on this gateway, offered on `#`.
    case session(PeerSession)

    var id: String {
      switch self {
      case .file(let match): return "@\(match.relative)"
      case .command(let command): return "/\(command.name)"
      case .skill(let skill): return "skill:\(skill.name)"
      case .session(let peer): return "session:\(peer.id)"
      }
    }

    /// What replaces the token - without its prefix, which `PromptTokens` adds.
    /// For a skill this is the whole literal, prefix included (there is none).
    var value: String {
      switch self {
      case .file(let match): return match.relative
      case .command(let command): return command.name
      case .skill(let skill): return Self.prompt(for: skill)
      case .session(let peer): return peer.slug
      }
    }

    /// What a picked skill types: the engine's own suggested opener where it
    /// declared one, otherwise `$name` - codex's native way of referring to a
    /// skill in prompt text (its `skill-creator` documents `Use $skill-x at
    /// /path/to/skill-x to …`, and its bundled prompts read "Use $pdf to …").
    /// Always ends in a space, so the caret lands ready for the rest.
    static func prompt(for skill: SkillInfo) -> String {
      let trimmed = skill.defaultPrompt?.trimmingCharacters(in: .whitespacesAndNewlines)
      let base = (trimmed?.isEmpty == false ? trimmed! : "$\(skill.name)")
      return base.hasSuffix(" ") ? base : base + " "
    }
  }

  private(set) var suggestions: [Suggestion] = []
  /// True while a token is active - the composer shows the list only then.
  private(set) var isActive = false

  /// The other sessions on this gateway, newest-first; empty until they load.
  var peers: [PeerSession] = []
  /// Slash commands from `capabilities`; empty until that event lands.
  var commands: [SlashCommandInfo] = []
  /// Skills from the `skills` event; empty until that lands (for codex, on the
  /// session's first turn - listing needs a live child).
  var skills: [SkillInfo] = []
  /// Host-file search, absent until the session's cwd is known.
  var scope: HostFileScope? {
    didSet {
      guard scope?.cwd != oldValue?.cwd else { return }
      // A resume into a different directory invalidates both the results and
      // the verdict on whether this gateway serves host files at all.
      filesUnsupported = false
      cancel()
    }
  }

  /// Whether `/` has anything to offer. Read by the empty state, which must not
  /// advertise a popover that would open empty.
  var hasCommands: Bool { !commands.isEmpty }
  /// Whether the `/` list carries skills as well as commands.
  var hasSkills: Bool { skills.contains { $0.enabled } }
  /// Whether `#` has anything to offer.
  var hasSessions: Bool { !peers.isEmpty }
  /// The folded slugs a sent `#Name` may style against.
  var sessionNames: Set<String> { Set(peers.map { PeerMentions.key($0.slug) }) }
  /// The skill names a sent `$name` may style against.
  var skillNames: Set<String> { Set(skills.map(\.name)) }

  /// Whether `@file` completion is on offer: the session's cwd is known and this
  /// gateway hasn't already 404'd the search. Read by the empty state, which must
  /// not advertise a feature this server doesn't serve.
  var hasFileSearch: Bool { scope != nil && !filesUnsupported }

  private var task: Task<Void, Never>?
  private var filesUnsupported = false
  private var lastQuery: String?

  /// Enough rows to be useful, few enough to leave the transcript visible.
  private static let limit = 8
  private static let debounceNanoseconds: UInt64 = 150_000_000

  /// Call on every edit, with the caret the edit left behind.
  func update(for text: String, cursor: String.Index?) {
    guard let token = PromptTokens.active(in: text, at: cursor ?? text.endIndex) else {
      cancel()
      return
    }
    switch token.kind {
    case .command: showCommands(matching: token.query)
    case .session: showSessions(matching: token.query)
    case .file: searchFiles(matching: token.query)
    // `$` is not a trigger: a skill is picked off the `/` list and inserted as
    // the `$name` the model reads.
    case .skill: cancel()
    }
  }

  /// Insert a chosen suggestion and close the list. The token is re-read from the
  /// current draft rather than remembered: the text may have moved on since the
  /// list was built, and replacing a stale range would corrupt the message.
  func accept(_ suggestion: Suggestion, in text: String, cursor: String.Index?)
    -> (text: String, cursor: String.Index)
  {
    let caret = cursor ?? text.endIndex
    defer { cancel() }
    guard let token = PromptTokens.active(in: text, at: caret) else { return (text, caret) }
    // A skill types prose over the `$name`; a command and a file resolve to
    // tokens the transcript will style. Different keys, different results.
    if case .skill = suggestion {
      return PromptTokens.replace(with: suggestion.value, replacing: token, in: text)
    }
    return PromptTokens.apply(suggestion.value, replacing: token, in: text)
  }

  /// The gateway's own session list, as the `#` picker needs it: this session
  /// dropped, newest first. The gateway still resolves what was typed against the
  /// sender's scope, so a stale row costs nothing worse than a plain-text name.
  static func peerSessions(_ rows: [SessionInfo], excluding sessionId: String) -> [PeerSession] {
    rows
      .filter { $0.id != sessionId }
      .sorted { ($0.lastActivityAt ?? $0.createdAt) > ($1.lastActivityAt ?? $1.createdAt) }
      .map {
        PeerSession(
          id: $0.id,
          slug: PeerMentions.slug(title: $0.title, id: $0.id),
          label: sessionLabel($0),
          engine: $0.engine,
          status: $0.status,
          project: $0.project?.name)
      }
  }

  func cancel() {
    task?.cancel()
    task = nil
    lastQuery = nil
    suggestions = []
    isActive = false
  }

  // MARK: - The three halves

  /// Local and immediate, and **one list**: engine commands first, then skills,
  /// the order `mergeComposerRows` gives every other client. Matches on the
  /// command name, its aliases, and the bare name of a namespaced one - typing
  /// "wrapup" should find "dev:wrapup".
  private func showCommands(matching query: String) {
    task?.cancel()
    task = nil
    lastQuery = nil
    isActive = true
    let needle = query.lowercased()
    let matchedCommands =
      commands
      .filter { needle.isEmpty || $0.matches(prefix: needle) }
      .map(Suggestion.command)
    let matchedSkills =
      skills
      .filter { $0.enabled && (needle.isEmpty || $0.matches(prefix: needle)) }
      .map(Suggestion.skill)
    suggestions = Array((matchedCommands + matchedSkills).prefix(20))
  }

  /// Local and immediate. The list arrives newest-first and an empty query keeps
  /// that order: which session moved last is the most useful thing it can say.
  private func showSessions(matching query: String) {
    task?.cancel()
    task = nil
    lastQuery = nil
    isActive = true
    let needle = query.lowercased()
    suggestions =
      peers
      .filter { needle.isEmpty || $0.matches(prefix: needle) }
      .prefix(20)
      .map(Suggestion.session)
  }

  private func searchFiles(matching query: String) {
    guard !filesUnsupported, let scope else {
      cancel()
      return
    }
    guard query != lastQuery else { return }
    lastQuery = query
    isActive = true
    task?.cancel()
    task = Task { [scope] in
      try? await Task.sleep(nanoseconds: Self.debounceNanoseconds)
      guard !Task.isCancelled else { return }
      do {
        let response = try await scope.client.findHostFiles(
          in: scope.cwd, matching: query, limit: Self.limit)
        guard !Task.isCancelled else { return }
        suggestions = response.matches.map(Suggestion.file)
      } catch let error as WorkerClientError where error.statusCode == 404 {
        // No host files on this gateway (or the cwd isn't under a root). Stop
        // asking - the answer will not change while this session is open.
        filesUnsupported = true
        cancel()
      } catch {
        // A failed lookup shows no suggestions; it is not worth an error banner
        // over an affordance the user can ignore.
        suggestions = []
      }
    }
  }
}

extension SlashCommandInfo {
  fileprivate func matches(prefix needle: String) -> Bool {
    let candidates = [name] + (aliases ?? []) + name.split(separator: ":").map(String.init)
    return candidates.contains { $0.lowercased().hasPrefix(needle) }
  }
}

/// One other session, as the `#` picker needs it.
struct PeerSession: Identifiable, Equatable, Sendable {
  let id: String
  /// What the composer writes after the `#`, and what the gateway folds to resolve it.
  let slug: String
  let label: String
  let engine: ProfileEngine?
  let status: SessionStatus
  let project: String?

  fileprivate func matches(prefix needle: String) -> Bool {
    let candidates = [slug, label] + slug.split(separator: "-").map(String.init)
    return candidates.contains { $0.lowercased().hasPrefix(needle) }
  }
}

extension SkillInfo {
  fileprivate func matches(prefix needle: String) -> Bool {
    let candidates =
      [name] + name.split(whereSeparator: { "-:_".contains($0) }).map(String.init)
    return candidates.contains { $0.lowercased().hasPrefix(needle) }
  }
}
