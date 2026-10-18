import Foundation
import CryptoKit
import Security

/// Minimal encrypted local storage for private GPS samples and unsubmitted
/// catch photos (spec §11.9). AES-GCM with a device-only Keychain key, written
/// with file protection that still allows background writes while locked
/// (location updates keep arriving with the screen off).
enum EncryptedStore {
    private static let keyTag = "com.manhuntcrews.offline-queue-key"

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("SecureQueue", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var d = dir
            try? d.setResourceValues(values)
        }
        return dir
    }

    static func key() throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyTag,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data {
            return SymmetricKey(data: data)
        }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyTag,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else { throw NSError(domain: "EncryptedStore", code: Int(status)) }
        return key
    }

    static func write(_ data: Data, name: String) throws {
        let sealed = try AES.GCM.seal(data, using: key())
        guard let combined = sealed.combined else { throw NSError(domain: "EncryptedStore", code: -1) }
        try combined.write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func read(name: String) -> Data? {
        let url = directory.appendingPathComponent(name)
        guard let combined = try? Data(contentsOf: url), let box = try? AES.GCM.SealedBox(combined: combined), let k = try? key() else { return nil }
        return try? AES.GCM.open(box, using: k)
    }

    static func remove(name: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }

    static func list(prefix: String) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).filter { $0.hasPrefix(prefix) }
    }

    /// Wipe everything (logout / account deletion).
    static func purgeAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}
