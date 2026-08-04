import Foundation
import Observation

/// The saved gateways, plus which one is open.
///
/// Hosts live in the Keychain as one JSON blob (see `KeychainStore`); the
/// selection is a plain UserDefaults id, so relaunching drops the user straight
/// back into the host they were last using.
@MainActor
@Observable
final class HostStore {
  private static let service = "bi.atomic.workerdeck.ios.hosts"
  private static let account = "hosts"
  private static let selectionKey = "bi.atomic.workerdeck.ios.selectedHostID"

  private(set) var hosts: [Host] = []
  private(set) var selectedHostID: UUID?

  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let stored = KeychainStore.load(service: Self.service, account: Self.account)
    hosts = stored.flatMap { try? JSONDecoder().decode([Host].self, from: $0) } ?? []
    if let raw = defaults.string(forKey: Self.selectionKey), let id = UUID(uuidString: raw),
      hosts.contains(where: { $0.id == id })
    {
      selectedHostID = id
    }
  }

  var selectedHost: Host? { hosts.first { $0.id == selectedHostID } }

  /// Insert or replace by id, then persist.
  func upsert(_ host: Host) {
    if let index = hosts.firstIndex(where: { $0.id == host.id }) {
      hosts[index] = host
    } else {
      hosts.append(host)
    }
    persistHosts()
    // First host added: open it, so nobody has to tap twice on a fresh install.
    if selectedHostID == nil, hosts.count == 1 { select(host.id) }
  }

  func delete(_ host: Host) {
    hosts.removeAll { $0.id == host.id }
    persistHosts()
    if selectedHostID == host.id { select(nil) }
  }

  func select(_ id: UUID?) {
    selectedHostID = id
    if let id {
      defaults.set(id.uuidString, forKey: Self.selectionKey)
    } else {
      defaults.removeObject(forKey: Self.selectionKey)
    }
  }

  private func persistHosts() {
    guard let data = try? JSONEncoder().encode(hosts) else { return }
    KeychainStore.save(data, service: Self.service, account: Self.account)
  }
}
