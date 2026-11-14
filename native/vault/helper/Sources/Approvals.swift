// Approval tokens (spec §3) and the text of every presence prompt (D3, D4).
//
// token = base64url(JSON(claims)) "." base64url(HMAC-SHA256(key, firstPart)),
// claims = {v:1, vaultId, action, detailSha256, nonce, exp}.
// Guest-verified actions are signed with the vault's per-boot approval key
// (vaultd holds it); egress / resize / destroy / lock-timeout with this process's own key and
// verified here, single use.
//
// Main never supplies prompt text. It names an action and a detail; the helper
// checks the detail's form per action, sanitises what it shows, and builds the
// sentence itself around the agent name from the signed vault.json. Free-text
// details (move-in, install) are logged, never shown (L1); agent names are
// limited at create to letters, digits, spaces and . _ - ' ( ).
import CryptoKit
import Foundation
import LocalAuthentication

struct ApprovalError: Error {
  let code: String
  let message: String
}

enum Approvals {
  /// Signs the helper-verified tokens; lives as long as this process.
  static let helperKey = SecretBytes(random: 32)
  private static var usedNonces: [String: Int64] = [:]  // nonce → exp, main queue only

  /// `exp` defaults to now + the action's TTL; `proxyCred` only for move-in/install (D37).
  static func mint(vaultId: String, action: String, detail: String, key: SecretBytes,
                   exp: Int64? = nil, proxyCred: String? = nil) -> String {
    var claims: [String: Any] = [
      "v": 1, "vaultId": vaultId, "action": action, "detailSha256": sha256Hex(detail),
      "nonce": hex(randomBytes(16)), "exp": exp ?? (nowMs() + (APPROVAL_TTL_MS[action] ?? 600_000)),
    ]
    if let c = proxyCred { claims["proxyCred"] = c }
    let first = base64url(Data(jsonBytes(claims)))
    let mac = HMAC<SHA256>.authenticationCode(for: Data(first.utf8), using: SymmetricKey(data: key.bytes))
    return first + "." + base64url(Data(mac))
  }

  static func expiry(_ token: String) -> Int64? {
    guard let first = token.split(separator: ".").first, let d = unbase64url(String(first)),
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
    return (o["exp"] as? NSNumber)?.int64Value
  }

  /// Verifies a helper-verified token for exactly this call and burns its nonce.
  static func verifyHelperToken(_ token: String, vaultId: String, action: String, detail: String) throws {
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2, let mac = unbase64url(String(parts[1])) else { throw bad("malformed token") }
    let expected = HMAC<SHA256>.authenticationCode(for: Data(parts[0].utf8), using: SymmetricKey(data: helperKey.bytes))
    guard constantTimeEqual([UInt8](mac), Array(expected)) else { throw bad("token signature does not match") }
    guard let d = unbase64url(String(parts[0])), let c = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          (c["v"] as? NSNumber)?.intValue == 1, let nonce = c["nonce"] as? String,
          let exp = (c["exp"] as? NSNumber)?.int64Value
    else { throw bad("malformed claims") }
    guard c["vaultId"] as? String == vaultId else { throw bad("token is for another vault") }
    guard c["action"] as? String == action else { throw bad("token is for another action") }
    guard c["detailSha256"] as? String == sha256Hex(detail) else { throw bad("token approves something else") }
    let now = nowMs()
    guard exp > now else { throw bad("token expired") }
    usedNonces = usedNonces.filter { $0.value > now }
    guard usedNonces[nonce] == nil else { throw bad("token already used") }
    usedNonces[nonce] = exp
  }

  private static func bad(_ m: String) -> ApprovalError { ApprovalError(code: "bad_token", message: m) }

  // MARK: prompt text

  static func agentLabel(_ name: String) -> String {
    let n = sanitizeForPrompt(name, max: 60)
    return "\u{201C}\(n.isEmpty ? "unnamed" : n)\u{201D}"
  }

  /// The reason shown for unlocking. `purpose` from main is logged, not shown.
  static func unlockReason(agentName: String) -> String {
    "unlock the vault of agent \(agentLabel(agentName))"
  }

  /// Validates `detail` for `action` and returns the sentence the system prompt
  /// shows after "VaultHelper is trying to …".
  static func reason(action: String, detail: String, agentName: String, sizeBytes: Int64) throws -> String {
    let agent = agentLabel(agentName)
    func invalid(_ m: String) -> ApprovalError { ApprovalError(code: "invalid", message: m) }
    switch action {
    case "move-in", "install":
      // L1: the detail is main's free text; it is logged by the caller, never shown.
      guard detail.count <= 400 else { throw invalid("detail too long") }
      return action == "move-in"
        ? "move files into the vault of agent \(agent) and install its dependencies"
        : "install or update dependencies in the vault of agent \(agent)"
    case "export":
      guard detail.hasPrefix("export:"), detail.count > 7, detail.count <= 1024, detail != "export:agent:all" else {
        throw invalid("export detail must be export:<path>")
      }
      return "export \u{201C}\(sanitizeForPrompt(String(detail.dropFirst(7)), max: 80))\u{201D} from the vault of agent \(agent)"
    case "move-out":
      guard detail == "export:agent:all" else { throw invalid("move-out detail must be export:agent:all") }
      return "move agent \(agent) out of its vault and back onto this Mac"
    case "terminal":
      guard detail == "exec:shell" else { throw invalid("terminal detail must be exec:shell") }
      return "open a terminal inside the vault of agent \(agent)"
    case "egress":
      guard let hosts = parseEgressDetail(detail) else { throw invalid("egress detail must be egress:<sorted hosts>") }
      if hosts.isEmpty { return "turn off network access for the vault of agent \(agent)" }
      var shown = hosts.prefix(6).joined(separator: ", ")
      if hosts.count > 6 { shown += " and \(hosts.count - 6) more" }
      return "let the vault of agent \(agent) reach \(shown)"
    case "resize":
      guard let n = parseResizeDetail(detail) else { throw invalid("resize detail must be resize:<bytes>") }
      guard n > sizeBytes else { throw invalid("a vault disk can only grow") }
      return "raise the disk size limit of the vault of agent \(agent) to \(gb(n))"
    case "lock-timeout":
      guard let ms = parseLockTimeoutDetail(detail) else { throw invalid("lock-timeout detail must be lock-timeout:<ms>") }
      return ms == 0
        ? "keep the vault of agent \(agent) unlocked until Cinna quits"
        : "keep the vault of agent \(agent) unlocked for \(duration(ms)) after use"
    case "destroy":
      guard detail == "destroy" else { throw invalid("destroy detail must be destroy") }
      return "permanently delete the vault of agent \(agent) and everything in it"
    default:
      throw invalid("unknown action \(action)")
    }
  }

  static func egressDetail(_ hosts: [String]) -> String { "egress:" + canonicalHosts(hosts).joined(separator: ",") }
  static func resizeDetail(_ size: Int64) -> String { "resize:\(size)" }
  /// protocol.ts approvalDetail({method:'vault.setLockTimeout'}).
  static func lockTimeoutDetail(_ ms: Int64) -> String { "lock-timeout:\(ms)" }

  static func parseLockTimeoutDetail(_ d: String) -> Int64? {
    guard d.hasPrefix("lock-timeout:"), let n = Int64(d.dropFirst(13)), LOCK_TIMEOUTS.contains(n) else { return nil }
    return n
  }

  /// "30 seconds", "5 minutes": the offered timeouts in words.
  static func duration(_ ms: Int64) -> String {
    let s = ms / 1000
    if s % 60 != 0 || s < 60 { return s == 1 ? "1 second" : "\(s) seconds" }
    let m = s / 60
    return m == 1 ? "1 minute" : "\(m) minutes"
  }

  static func parseEgressDetail(_ d: String) -> [String]? {
    guard d.hasPrefix("egress:") else { return nil }
    let body = String(d.dropFirst(7))
    let hosts = body.isEmpty ? [] : body.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
    guard hosts.allSatisfy(isValidHostPattern), hosts == canonicalHosts(hosts) else { return nil }
    return hosts
  }

  static func parseResizeDetail(_ d: String) -> Int64? {
    guard d.hasPrefix("resize:"), let n = Int64(d.dropFirst(7)), n >= MIN_VAULT_SIZE, n <= MAX_VAULT_SIZE else { return nil }
    return n
  }

  static func gb(_ n: Int64) -> String {
    let v = Double(n) / Double(1 << 30)
    return v == v.rounded() ? "\(Int(v)) GB" : String(format: "%.1f GB", v)
  }
}

/// Presence prompts (the caller serialises them on its prompt queue); completion on main.
enum Presence {

  static func require(reason: String, completion: @escaping (ApprovalError?) -> Void) {
    #if VAULT_TEST_GATE
    logStderr("test gate: granted without a prompt: \(reason)")
    Control.emitLog("info", "test gate granted: \(reason)")
    DispatchQueue.main.async { completion(nil) }
    #else
    let ctx = LAContext()
    ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, err in
      DispatchQueue.main.async {
        if ok { completion(nil); return }
        let code = (err as? LAError)?.code
        if code == .userCancel || code == .appCancel || code == .systemCancel || code == .authenticationFailed || code == .userFallback {
          completion(ApprovalError(code: "denied", message: "the user did not approve"))
        } else {
          completion(ApprovalError(code: "denied", message: "presence check failed: \(err?.localizedDescription ?? "unknown")"))
        }
      }
    }
    #endif
  }
}
