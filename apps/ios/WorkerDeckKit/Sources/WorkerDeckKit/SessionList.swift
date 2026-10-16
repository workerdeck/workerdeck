import Foundation

public enum SessionState: String, Codable, Sendable, Hashable, CaseIterable {
  case attention
  case working
  case idle
  case ended
}

public func sessionState(_ info: SessionInfo) -> SessionState {
  if info.pendingPermissionCount > 0 || info.status == .awaitingApproval { return .attention }
  if info.status == .failed || info.status == .closed { return .ended }
  if info.status == .running || info.status == .starting { return .working }
  if !runningSubagents(info).isEmpty { return .working }
  return .idle
}

public func runningSubagents(_ info: SessionInfo) -> [SubagentInfo] {
  (info.subagents ?? []).filter { $0.status == .running }
}

public func sessionLabel(_ info: SessionInfo) -> String {
  info.title ?? String(info.id.prefix(8))
}

public func projectLabel(_ info: SessionInfo) -> String {
  if let shortcode = info.project?.shortcode, !shortcode.isEmpty { return shortcode }
  if let name = info.project?.name, !name.isEmpty { return name }
  let dir = normalizePath(info.cwd)
  if let slash = dir.lastIndex(of: "/") {
    let base = String(dir[dir.index(after: slash)...])
    return base.isEmpty ? "No project" : base
  }
  return dir.isEmpty ? "No project" : dir
}

public func projectSubpath(_ info: SessionInfo) -> String? {
  guard let root = info.project?.root, !info.cwd.isEmpty else { return nil }
  let base = normalizePath(root)
  let dir = normalizePath(info.cwd)
  if dir == base { return nil }
  guard dir.hasPrefix(base + "/") else { return nil }
  let relative = String(dir.dropFirst(base.count + 1))
  return relative.isEmpty ? nil : relative
}

private func normalizePath(_ path: String) -> String {
  var unified = path.replacingOccurrences(of: "\\", with: "/")
  while unified.hasSuffix("/") { unified.removeLast() }
  return unified
}
