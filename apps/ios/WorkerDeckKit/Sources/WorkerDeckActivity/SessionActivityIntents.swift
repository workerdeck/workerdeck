import Foundation

/// What a button on the card is asking for, in the one vocabulary both processes share.
public enum SessionActivityAction: Sendable, Equatable {
  case approve(sessionId: String, hostId: String?, requestId: String)
  case deny(sessionId: String, hostId: String?, requestId: String)
  case choose(sessionId: String, hostId: String?, requestId: String, choiceIndex: Int)

  public var sessionId: String {
    switch self {
    case .approve(let sessionId, _, _), .deny(let sessionId, _, _), .choose(let sessionId, _, _, _):
      return sessionId
    }
  }
}

/// The seam between the intent and the app that can actually answer it.
///
/// The intents below are compiled into **both** the app and the widget extension - the extension
/// needs the symbols to build `Button(intent:)`, the app needs them to perform. Only the app
/// installs a handler, from `application(_:didFinishLaunchingWithOptions:)`: that runs on a
/// scene-less background launch, where the SwiftUI `.task` never does.
///
/// If the handler is nil the intent is being performed somewhere that cannot reach a gateway
/// credential, and saying so is the only honest outcome. It should not happen - a
/// `LiveActivityIntent` is performed by the app process - but a silent no-op on a tapped button
/// would be indistinguishable from an approval that vanished.
@MainActor
public enum SessionActivityActions {
  public typealias Handler = @MainActor @Sendable (SessionActivityAction) async -> Void

  public static var handler: Handler?

  static func run(_ action: SessionActivityAction) async {
    guard let handler else { return }
    await handler(action)
  }
}

#if canImport(AppIntents) && os(iOS)
  import AppIntents

  /// Conforming to `LiveActivityIntent` rather than plain `AppIntent` is the whole security design:
  /// the system launches the *app* in the background to perform it, so the widget extension never
  /// needs the Bearer key and no Keychain access group has to be shared with it. A plain
  /// `AppIntent` with `openAppWhenRun = false` is also the shape whose `perform()` is silently
  /// never called from a Live Activity button.
  public struct ApproveSessionRequestIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Approve"
    public static let openAppWhenRun = false

    @Parameter(title: "Session") public var sessionId: String
    @Parameter(title: "Host") public var hostId: String?
    @Parameter(title: "Request") public var requestId: String

    public init() {}

    public init(sessionId: String, hostId: String?, requestId: String) {
      self.sessionId = sessionId
      self.hostId = hostId
      self.requestId = requestId
    }

    public func perform() async throws -> some IntentResult {
      await SessionActivityActions.run(.approve(sessionId: sessionId, hostId: hostId, requestId: requestId))
      return .result()
    }
  }

  public struct DenySessionRequestIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Deny"
    public static let openAppWhenRun = false

    @Parameter(title: "Session") public var sessionId: String
    @Parameter(title: "Host") public var hostId: String?
    @Parameter(title: "Request") public var requestId: String

    public init() {}

    public init(sessionId: String, hostId: String?, requestId: String) {
      self.sessionId = sessionId
      self.hostId = hostId
      self.requestId = requestId
    }

    public func perform() async throws -> some IntentResult {
      await SessionActivityActions.run(.deny(sessionId: sessionId, hostId: hostId, requestId: requestId))
      return .result()
    }
  }

  public struct ChooseSessionAnswerIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Answer"
    public static let openAppWhenRun = false

    @Parameter(title: "Session") public var sessionId: String
    @Parameter(title: "Host") public var hostId: String?
    @Parameter(title: "Request") public var requestId: String
    @Parameter(title: "Choice") public var choiceIndex: Int

    public init() {}

    public init(sessionId: String, hostId: String?, requestId: String, choiceIndex: Int) {
      self.sessionId = sessionId
      self.hostId = hostId
      self.requestId = requestId
      self.choiceIndex = choiceIndex
    }

    public func perform() async throws -> some IntentResult {
      await SessionActivityActions.run(
        .choose(sessionId: sessionId, hostId: hostId, requestId: requestId, choiceIndex: choiceIndex))
      return .result()
    }
  }
#endif
