// Key custody (D17, D22).
//
// Release and dev flavors:
// - One Secure Enclave P-256 key-agreement key, permanent, in the
//   data-protection keychain under KEYCHAIN_GROUP, with access control
//   [.privateKeyUsage, .userPresence] and WhenUnlockedThisDeviceOnly. Only code
//   signed with our team's profile claiming the group can even look it up.
// - Each vault's 32-byte disk key is wrapped ECIES-style with its public key:
//   ephemeral P-256 · ECDH · HKDF-SHA256 (info "cinna-vault-disk-key-v1") ·
//   AES-GCM. Blob = ephemeral X‖Y (64) ‖ nonce ‖ ciphertext ‖ tag. Wrapping
//   needs no prompt; unwrapping uses the SE key and prompts.
// - vault.json is signed with HMAC-SHA256 under a per-install key stored as a
//   generic password in the same group (no user presence), and the SHA-256 of
//   the current vault.json (and of one pending write) is kept per vault in the
//   group too, so restoring an older, validly signed vault.json (rollback) is
//   detected.
//
// Test flavor (VAULT_TEST_GATE): no keychain at all. The disk key sits in
// plain text in <vault>/test.key, vault.json is signed with a fixed key, and the
// rollback digests are plain files beside it. Nothing about it is secret; it exists for the E2E
// and live lanes and is compiled out of release builds.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct CustodyError: Error {
  let code: String
  let message: String
}

let WRAP_INFO = Data("cinna-vault-disk-key-v1".utf8)
let SE_KEY_TAG = Data("io.opencinna.desktop.vault-helper.disk-wrap.v1".utf8)
let SIGNING_ACCOUNT = "vault-json-hmac.v1"
func digestAccount(_ vaultId: String) -> String { "vault-json-digest:\(vaultId)" }

enum KeyCustody {
  // MARK: disk key

  /// A fresh disk key, wrapped: what vault.json stores. The plain key is
  /// zeroed here; the first unlock unwraps it again (and prompts).
  static func newDiskKey(vaultDir: URL) throws -> String {
    let key = SecretBytes(random: 32)
    defer { key.zero() }
    #if VAULT_TEST_GATE
    let path = vaultDir.appendingPathComponent("test.key").path
    guard FileManager.default.createFile(atPath: path, contents: Data(hexBytes(key.bytes)), attributes: [.posixPermissions: 0o600]) else {
      throw CustodyError(code: "internal", message: "could not write test.key")
    }
    return "test-flavor-plaintext"
    #else
    let pub = try publicKey()
    let eph = P256.KeyAgreement.PrivateKey()
    let shared = try eph.sharedSecretFromKeyAgreement(with: pub)
    let wrapKey = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: WRAP_INFO, outputByteCount: 32)
    var plain = Data(key.bytes)
    defer { zeroData(&plain) }
    let sealed = try AES.GCM.seal(plain, using: wrapKey)
    var blob = eph.publicKey.rawRepresentation
    blob.append(sealed.combined!)
    return blob.base64EncodedString()
    #endif
  }

  /// Unwraps a vault's disk key. Blocks on the user-presence prompt: never call on main.
  static func unwrap(vaultDir: URL, wrapped: String, reason: String) throws -> SecretBytes {
    #if VAULT_TEST_GATE
    logStderr("test gate: unlock granted without a prompt (\(reason))")
    guard let d = FileManager.default.contents(atPath: vaultDir.appendingPathComponent("test.key").path),
          let k = unhex(String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)), k.count == 32
    else { throw CustodyError(code: "internal", message: "test.key missing or malformed") }
    return SecretBytes(k)
    #else
    guard let blob = Data(base64Encoded: wrapped), blob.count == 64 + 12 + 32 + 16 else {
      throw CustodyError(code: "tampered", message: "wrapped key malformed")
    }
    let ctx = LAContext()
    ctx.localizedReason = reason
    let priv = try privateKey(context: ctx, create: false)
    var ephRaw = Data([0x04]); ephRaw.append(blob.prefix(64))
    var err: Unmanaged<CFError>?
    guard let ephPub = SecKeyCreateWithData(ephRaw as CFData, [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass: kSecAttrKeyClassPublic,
    ] as CFDictionary, &err) else { throw CustodyError(code: "tampered", message: "wrapped key malformed") }
    // The Touch ID / password prompt is raised here.
    guard var shared = SecKeyCopyKeyExchangeResult(priv, .ecdhKeyExchangeStandard, ephPub, [:] as CFDictionary, &err) as Data? else {
      let e = err!.takeRetainedValue()
      throw mapAuthError(e)
    }
    defer { zeroData(&shared) }
    let wrapKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: shared), salt: Data(), info: WRAP_INFO, outputByteCount: 32)
    do {
      var plain = try AES.GCM.open(AES.GCM.SealedBox(combined: blob.dropFirst(64)), using: wrapKey)
      defer { zeroData(&plain) }
      guard plain.count == 32 else { throw CustodyError(code: "tampered", message: "disk key has the wrong size") }
      return SecretBytes([UInt8](plain))
    } catch let e as CustodyError {
      throw e
    } catch {
      throw CustodyError(code: "tampered", message: "wrapped key does not open with this Mac's vault key")
    }
    #endif
  }

  #if !VAULT_TEST_GATE
  static func mapAuthError(_ e: CFError) -> CustodyError {
    let code = CFErrorGetCode(e)
    let domain = CFErrorGetDomain(e) as String
    // errSecUserCanceled (-128), errSecAuthFailed (-25293), LAError cancels (-2, -4, -9 …).
    if code == Int(errSecUserCanceled) || code == Int(errSecAuthFailed) || domain == LAErrorDomain {
      return CustodyError(code: "denied", message: "the user did not approve")
    }
    return CustodyError(code: "internal", message: "key agreement failed: \(domain) \(code)")
  }

  private static func keyQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrApplicationTag as String: SE_KEY_TAG,
      kSecAttrAccessGroup as String: KEYCHAIN_GROUP,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  /// Looks the SE key up (no prompt: the prompt comes with its first use), creating it on first use if asked.
  static func privateKey(context: LAContext?, create: Bool) throws -> SecKey {
    var q = keyQuery()
    q[kSecReturnRef as String] = true
    if let ctx = context { q[kSecUseAuthenticationContext as String] = ctx }
    var item: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &item)
    if st == errSecSuccess, let k = item { return (k as! SecKey) }
    if st != errSecItemNotFound {
      throw CustodyError(code: "internal", message: "vault key lookup failed (OSStatus \(st))")
    }
    if !create { throw CustodyError(code: "internal", message: "this Mac's vault key is gone; the vault cannot be opened") }
    var err: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err) else {
      throw CustodyError(code: "internal", message: "access control: \(err!.takeRetainedValue())")
    }
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecUseDataProtectionKeychain as String: true,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: SE_KEY_TAG,
        kSecAttrAccessGroup as String: KEYCHAIN_GROUP,
        kSecAttrAccessControl as String: ac,
      ] as [String: Any],
    ]
    guard let k = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else {
      let e = err!.takeRetainedValue()
      // WhenUnlockedThisDeviceOnly: the Secure Enclave refuses while the Mac's screen is locked.
      if CFErrorGetCode(e) == Int(errSecInteractionNotAllowed) {
        throw CustodyError(code: "unavailable", message: "this Mac is locked; unlock it and try again")
      }
      throw CustodyError(code: "internal", message: "could not create the vault key: \(e)")
    }
    logStderr("created this Mac's vault key in the Secure Enclave")
    return k
  }

  private static func publicKey() throws -> P256.KeyAgreement.PublicKey {
    let ctx = LAContext()
    ctx.interactionNotAllowed = true
    let priv = try privateKey(context: ctx, create: true)
    guard let pub = SecKeyCopyPublicKey(priv) else { throw CustodyError(code: "internal", message: "no public key") }
    var err: Unmanaged<CFError>?
    guard let raw = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
      throw CustodyError(code: "internal", message: "public key export: \(err!.takeRetainedValue())")
    }
    return try P256.KeyAgreement.PublicKey(x963Representation: raw)
  }

  // MARK: generic passwords in the group

  private static func passwordQuery(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: KEYCHAIN_SERVICE,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: KEYCHAIN_GROUP,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  static func readPassword(_ account: String) throws -> Data? {
    var q = passwordQuery(account)
    q[kSecReturnData as String] = true
    var item: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &item)
    if st == errSecItemNotFound { return nil }
    guard st == errSecSuccess, let d = item as? Data else {
      throw CustodyError(code: "internal", message: "keychain read failed (OSStatus \(st))")
    }
    return d
  }

  static func writePassword(_ account: String, _ data: Data) throws {
    let st = SecItemUpdate(passwordQuery(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if st == errSecSuccess { return }
    guard st == errSecItemNotFound else { throw CustodyError(code: "internal", message: "keychain update failed (OSStatus \(st))") }
    var add = passwordQuery(account)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let st2 = SecItemAdd(add as CFDictionary, nil)
    guard st2 == errSecSuccess else { throw CustodyError(code: "internal", message: "keychain add failed (OSStatus \(st2))") }
  }

  static func deletePassword(_ account: String) {
    SecItemDelete(passwordQuery(account) as CFDictionary)
  }
  #endif

  // MARK: vault.json signing

  private static var cachedSigningKey: [UInt8]?

  static func signingKey() throws -> [UInt8] {
    if let k = cachedSigningKey { return k }
    #if VAULT_TEST_GATE
    let k = Array(SHA256.hash(data: Data("cinna-vault-test-flavor-signing-key-v1".utf8)))
    #else
    let k: [UInt8]
    if let d = try readPassword(SIGNING_ACCOUNT), d.count == 32 {
      k = [UInt8](d)
    } else {
      let fresh = randomBytes(32)
      try writePassword(SIGNING_ACCOUNT, Data(fresh))
      k = fresh
    }
    #endif
    cachedSigningKey = k
    return k
  }

  static func sign(_ data: Data) throws -> [UInt8] {
    Array(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: try signingKey())))
  }

  // MARK: rollback digests (M1)
  //
  // Two slots per vault: `current` (the SHA-256 of the vault.json last written)
  // and `pending` (set just before a write, promoted once the file is on disk).
  // A crash between the two steps leaves the file matching one of them, so a
  // save never strands a vault as "tampered"; any other file (an older, validly
  // signed one restored by the host) matches neither.
  // The test flavor keeps the slots in plain files beside test.key: nothing in
  // that flavor is secret, and it lets the smoke exercise the slot logic.

  enum DigestSlot: String { case current, pending }

  #if VAULT_TEST_GATE
  private static func slotURL(_ vaultDir: URL, _ slot: DigestSlot) -> URL {
    vaultDir.appendingPathComponent("test-digest.\(slot.rawValue)")
  }
  #else
  private static func slotAccount(_ vaultId: String, _ slot: DigestSlot) -> String {
    slot == .current ? digestAccount(vaultId) : digestAccount(vaultId) + ":pending"
  }
  #endif

  static func readDigest(vaultId: String, vaultDir: URL, _ slot: DigestSlot) throws -> String? {
    #if VAULT_TEST_GATE
    guard let d = FileManager.default.contents(atPath: slotURL(vaultDir, slot).path) else { return nil }
    return String(decoding: d, as: UTF8.self)
    #else
    return try readPassword(slotAccount(vaultId, slot)).map { String(decoding: $0, as: UTF8.self) }
    #endif
  }

  static func writeDigest(vaultId: String, vaultDir: URL, _ slot: DigestSlot, _ digest: String) throws {
    #if VAULT_TEST_GATE
    do { try Data(digest.utf8).write(to: slotURL(vaultDir, slot), options: .atomic) } catch {
      throw CustodyError(code: "internal", message: "could not write the test digest slot: \(error)")
    }
    #else
    try writePassword(slotAccount(vaultId, slot), Data(digest.utf8))
    #endif
  }

  static func clearDigest(vaultId: String, vaultDir: URL, _ slot: DigestSlot) {
    #if VAULT_TEST_GATE
    try? FileManager.default.removeItem(at: slotURL(vaultDir, slot))
    #else
    deletePassword(slotAccount(vaultId, slot))
    #endif
  }

  static func forget(vaultId: String, vaultDir: URL) {
    clearDigest(vaultId: vaultId, vaultDir: vaultDir, .current)
    clearDigest(vaultId: vaultId, vaultDir: vaultDir, .pending)
  }
}
