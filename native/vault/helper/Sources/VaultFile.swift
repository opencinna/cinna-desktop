// <dir>/<vaultId>/vault.json: one file, written atomically, holding the body and
// its signature together (M1), so no crash can leave a body with another
// body's signature:
//
//   {"sig":"<64 hex: HMAC-SHA256 of the body bytes>","vault":<body JSON bytes>}
//
// The envelope is fixed byte for byte (the body is verified as the exact bytes
// between the fixed prefix and the closing brace), and stays valid JSON for
// anyone reading it. Nothing in it is secret; the signature and the rollback
// digests (KeyCustody: current + pending slot) are what make a host edit or an
// old copy visible. The two-file layout of earlier builds (vault.json +
// vault.json.sig) reads as malformed.
import Foundation

let VAULT_ID_PATTERN = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{2,62}$")
func isValidVaultId(_ s: String) -> Bool {
  VAULT_ID_PATTERN.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

/// L1: an agent name the prompt may show: letters, digits, spaces and . _ - ' ( ),
/// at most 200 characters, not blank. (Still sanitised and capped when shown.)
func isValidAgentName(_ s: String) -> Bool {
  guard !s.isEmpty, s.count <= 200, !s.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
  return s.unicodeScalars.allSatisfy { u in
    u == " " || ".-_'()".unicodeScalars.contains(u) || u.properties.isAlphabetic || u.properties.numericType == .decimal
  }
}

let HOST_PATTERN = try! NSRegularExpression(
  pattern: "^(\\*\\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")

/// An allowlist entry: a lower-case DNS name with at least one dot, optionally
/// `*.` for subdomains; never an IP literal (the last label must start with a letter).
func isValidHostPattern(_ s: String) -> Bool {
  s.count <= 253 && HOST_PATTERN.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

/// protocol.ts approvalDetail({method:'vault.setEgress'}): lower-cased, de-duplicated, sorted, comma-joined.
func canonicalHosts(_ hosts: [String]) -> [String] {
  Array(Set(hosts.map { $0.trimmingCharacters(in: .whitespaces).lowercased() })).sorted()
}

struct VaultDoc {
  var vaultId: String
  var agentId: String
  var agentName: String
  var engine: String
  var sizeBytes: Int64
  var egress: [String]
  var createdAt: Int64
  var imageVersion: String
  var wrappedKey: String
  var pendingGrowTo: Int64?
  var formatted: Bool
  var rootfsPath: String

  func json() -> [String: Any] {
    var o: [String: Any] = [
      "v": 1, "vaultId": vaultId, "agentId": agentId, "agentName": agentName, "engine": engine,
      "sizeBytes": sizeBytes, "egress": ["hosts": egress], "createdAt": createdAt,
      "imageVersion": imageVersion, "wrappedKey": wrappedKey, "formatted": formatted, "rootfsPath": rootfsPath,
    ]
    if let g = pendingGrowTo { o["pendingGrowTo"] = g }
    return o
  }

  static func from(_ o: [String: Any]) -> VaultDoc? {
    guard let vaultId = o["vaultId"] as? String, let agentId = o["agentId"] as? String,
          let agentName = o["agentName"] as? String, let engine = o["engine"] as? String,
          let size = (o["sizeBytes"] as? NSNumber)?.int64Value,
          let egress = (o["egress"] as? [String: Any])?["hosts"] as? [String],
          let createdAt = (o["createdAt"] as? NSNumber)?.int64Value,
          let imageVersion = o["imageVersion"] as? String, let wrappedKey = o["wrappedKey"] as? String,
          let formatted = o["formatted"] as? Bool, let rootfsPath = o["rootfsPath"] as? String
    else { return nil }
    return VaultDoc(vaultId: vaultId, agentId: agentId, agentName: agentName, engine: engine, sizeBytes: size,
                    egress: egress, createdAt: createdAt, imageVersion: imageVersion, wrappedKey: wrappedKey,
                    pendingGrowTo: (o["pendingGrowTo"] as? NSNumber)?.int64Value, formatted: formatted,
                    rootfsPath: rootfsPath)
  }
}

enum VaultFiles {
  static func jsonURL(_ vaultDir: URL) -> URL { vaultDir.appendingPathComponent("vault.json") }
  static func dataURL(_ vaultDir: URL) -> URL { vaultDir.appendingPathComponent("data.img") }
  static func consoleURL(_ vaultDir: URL) -> URL { vaultDir.appendingPathComponent("console.log") }

  enum Loaded {
    case ok(VaultDoc)
    /// The best-effort fields of a file that failed verification (for display only).
    case tampered(String, [String: Any]?)
    case missing
  }

  private static let envPrefix = Array("{\"sig\":\"".utf8)
  private static let envMiddle = Array("\",\"vault\":".utf8)
  private static let envSuffix = Array("}".utf8)

  static func envelope(sig: [UInt8], body: [UInt8]) -> [UInt8] {
    envPrefix + hexBytes(sig) + envMiddle + body + envSuffix
  }

  /// (signature, exact body bytes), or nil when the file is not an envelope.
  static func parseEnvelope(_ b: [UInt8]) -> ([UInt8], [UInt8])? {
    let bodyStart = envPrefix.count + 64 + envMiddle.count
    guard b.count > bodyStart + envSuffix.count,
          Array(b[0..<envPrefix.count]) == envPrefix,
          Array(b[(envPrefix.count + 64)..<bodyStart]) == envMiddle,
          Array(b[(b.count - envSuffix.count)...]) == envSuffix,
          let sig = unhex(String(decoding: b[envPrefix.count..<(envPrefix.count + 64)], as: UTF8.self))
    else { return nil }
    return (sig, Array(b[bodyStart..<(b.count - envSuffix.count)]))
  }

  static func load(_ vaultDir: URL) -> Loaded {
    let folderId = vaultDir.lastPathComponent
    guard let data = FileManager.default.contents(atPath: jsonURL(vaultDir).path) else { return .missing }
    guard let (sig, body) = parseEnvelope([UInt8](data)) else {
      return .tampered("vault.json is not a signed vault file", nil)
    }
    let raw = (try? JSONSerialization.jsonObject(with: Data(body))) as? [String: Any]
    let expected: [UInt8]
    do { expected = try KeyCustody.sign(Data(body)) } catch { return .tampered("signing key unavailable: \(error)", raw) }
    guard constantTimeEqual(sig, expected) else { return .tampered("signature does not match", raw) }
    guard let o = raw, let doc = VaultDoc.from(o) else { return .tampered("vault.json malformed", raw) }
    guard doc.vaultId == folderId else { return .tampered("vault.json belongs to another vault", raw) }
    if let why = checkDigest(doc.vaultId, vaultDir, sha256Hex(data)) { return .tampered(why, raw) }
    return .ok(doc)
  }

  /// nil = the file is the one last written (current) or the one being written
  /// (pending, promoted here); otherwise why not.
  private static func checkDigest(_ vaultId: String, _ vaultDir: URL, _ digest: String) -> String? {
    let current: String?, pending: String?
    do {
      current = try KeyCustody.readDigest(vaultId: vaultId, vaultDir: vaultDir, .current)
      pending = try KeyCustody.readDigest(vaultId: vaultId, vaultDir: vaultDir, .pending)
    } catch {
      return "\(error)"
    }
    if let c = current, constantTimeEqual(Array(c.utf8), Array(digest.utf8)) {
      // A write that never reached the disk (or a junk pending slot): drop it.
      if pending != nil { KeyCustody.clearDigest(vaultId: vaultId, vaultDir: vaultDir, .pending) }
      return nil
    }
    if let p = pending, constantTimeEqual(Array(p.utf8), Array(digest.utf8)) {
      // The file was written but the save stopped before recording it: finish the save.
      do {
        try KeyCustody.writeDigest(vaultId: vaultId, vaultDir: vaultDir, .current, digest)
        KeyCustody.clearDigest(vaultId: vaultId, vaultDir: vaultDir, .pending)
        logStderr("vault \(vaultId): finished an interrupted vault.json save")
      } catch {
        logStderr("vault \(vaultId): could not promote the pending digest: \(error)")
      }
      return nil
    }
    if current == nil && pending == nil { return "no record of this vault on this Mac" }
    return "vault.json is not the version last written (rollback?)"
  }

  /// pending digest → vault.json (atomic, body + signature in one file) → current digest.
  static func save(_ doc: VaultDoc, _ vaultDir: URL) throws {
    let body = jsonBytes(doc.json())
    let file = envelope(sig: try KeyCustody.sign(Data(body)), body: body)
    let digest = sha256Hex(Data(file))
    try KeyCustody.writeDigest(vaultId: doc.vaultId, vaultDir: vaultDir, .pending, digest)
    try Data(file).write(to: jsonURL(vaultDir), options: .atomic)
    try KeyCustody.writeDigest(vaultId: doc.vaultId, vaultDir: vaultDir, .current, digest)
    KeyCustody.clearDigest(vaultId: doc.vaultId, vaultDir: vaultDir, .pending)
  }
}
