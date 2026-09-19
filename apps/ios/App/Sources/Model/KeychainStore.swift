import Foundation
import Security

/// Minimal `kSecClassGenericPassword` wrapper: read/write/delete one item's data.
///
/// The host list carries auth keys, so it belongs in the Keychain rather than
/// UserDefaults or a plist in the container. It is stored as a *single* JSON blob
/// (one item, not one per host) - adding or editing a host is then one atomic
/// write, and there is no partial state to reconcile on launch.
enum KeychainStore {
  static func load(service: String, account: String) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  @discardableResult
  static func save(_ data: Data, service: String, account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      // Background reconnects run while the phone is locked; first-unlock is the
      // strictest class that still allows that.
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return true }
    guard updated == errSecItemNotFound else { return false }
    return SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
      == errSecSuccess
  }

  @discardableResult
  static func delete(service: String, account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}
