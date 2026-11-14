// D26/D35: the helper serves only Cinna itself, started normally.
//
// Who is "the parent" is decided by the helper's stdin, not by getppid(): Node
// (libuv) creates a child's stdio pipes with socketpair(2), and LOCAL_PEERTOKEN
// on our end names the process that created the pair, as an audit token (pid +
// pid version). A pid alone is racy: an attacker could fork, start the helper
// with its own pipes, then exec Cinna in the same pid. The pid version changes
// on exec, so a token taken before it no longer resolves afterwards.
//
// The peer must:
// - resolve by audit token (SecCodeCopyGuestWithAttributes, kSecGuestAttributeAudit)
//   and satisfy the requirement: Cinna's identifier, our team, Developer ID
//   (release) or any Apple-issued certificate of the team (dev: Apple Development
//   too), with a valid dynamic signature;
// - run with the hardened runtime;
// - not have ELECTRON_RUN_AS_NODE in its launch environment (KERN_PROCARGS2):
//   the RunAsNode fuse is still on, so without that check any process could run
//   its own JS as the signed Cinna binary and drive the helper.
// The token is resolved a second time after the environment read, so a peer
// that exec'd (or died and whose pid was reused) during the check fails.
//
// stdin that is not a socket (a file, a pipe(2), a tty) is untrusted.
//
// The startup check alone does not close the exec race: xnu computes
// LOCAL_PEERTOKEN when asked, from the last process that did I/O on the peer
// socket. A check that runs after the attacker's exec (delayed with SIGSTOP,
// say) sees genuine Cinna, while a forked accomplice keeps a copy of the fd.
// So the verified (pid, pid version) is pinned and the token is read again
// after every frame from stdin (PeerPin.stillPinned): the token then names the
// frame's sender, and anything but the verified process ends the helper. The
// exec'd Cinna never writes on an fd it does not know. (Measured 2026-11-13:
// the token follows the last writer; the pid version changes on exec.)
//
// Why Cinna's own writes do not refresh the token: the end of the helper's
// stdin socketpair that Cinna holds is a private fd libuv opens close-on-exec
// (uv_spawn's socketpair with SOCK_CLOEXEC), not Cinna's fd 1 or 2, so console
// and log output go elsewhere and never pass through that socket; nothing but
// Cinna's frame writer does I/O on it. The residual (review round 2, judged
// low, unproven): an attacker who launches Cinna itself with its stdout or
// stderr wired to the helper's stdin socket, and keeps an accomplice holding
// the same socket, could have a Cinna log write land between the accomplice's
// frame and our token re-read, so the token names Cinna for that frame. The
// log bytes are not frames, though: interleaved with the frame stream they
// break the length framing, and a bad frame ends the helper. No change made;
// a per-frame check that cannot be raced needs a channel only Cinna can write
// (XPC with an audit token per message), which Node does not offer (D25).
//
// The test flavor computes the verdict with the release requirement and
// reports it in `hello`, but does not enforce it unless
// CINNA_VAULT_TEST_ENFORCE_PARENT=1 (the smoke's parent-check probe).
import Darwin
import Foundation
import Security

struct ParentVerdict {
  let trusted: Bool
  /// What the check found; `trusted` may be forced true (test flavor) regardless.
  let verified: Bool
  let detail: String
}

/// Requirement text for the peer. The certificate OIDs are Apple's Developer ID
/// Application leaf (1.2.840.113635.100.6.1.13) and Developer ID intermediate
/// (1.2.840.113635.100.6.2.6) markers.
func parentRequirementText(identifier: String, team: String, developerIdOnly: Bool) -> String {
  var r = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
  if developerIdOnly {
    r += " and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
  }
  return r
}

let parentVerdict: ParentVerdict = {
  #if VAULT_TEST_GATE
  // The probe in helper-smoke.mjs points the check at a parent it can start
  // (the signed node binary); the override exists only in this flavor.
  let env = ProcessInfo.processInfo.environment
  let ident = env["CINNA_VAULT_TEST_PARENT_IDENTIFIER"] ?? PARENT_IDENTIFIER
  let team = env["CINNA_VAULT_TEST_PARENT_TEAM"] ?? TEAM_ID
  let v = checkParent(requirement: parentRequirementText(identifier: ident, team: team, developerIdOnly: true), label: ident)
  if env["CINNA_VAULT_TEST_ENFORCE_PARENT"] == "1" {
    PeerPin.enforced = true
    return ParentVerdict(trusted: v.verified, verified: v.verified, detail: "test flavor, enforced: \(v.detail)")
  }
  return ParentVerdict(trusted: true, verified: v.verified, detail: "test flavor, not enforced: \(v.detail)")
  #elseif VAULT_DEV
  return checkParent(requirement: parentRequirementText(identifier: PARENT_IDENTIFIER, team: TEAM_ID, developerIdOnly: false),
                     label: PARENT_IDENTIFIER)
  #else
  return checkParent(requirement: parentRequirementText(identifier: PARENT_IDENTIFIER, team: TEAM_ID, developerIdOnly: true),
                     label: PARENT_IDENTIFIER)
  #endif
}()

/// kSecCodeStatus bit for the hardened runtime (CS_RUNTIME in <kern/cs_blobs.h>).
private let CS_RUNTIME: UInt32 = 0x10000

func checkParent(requirement reqText: String, label: String) -> ParentVerdict {
  func no(_ d: String) -> ParentVerdict { ParentVerdict(trusted: false, verified: false, detail: d) }

  var st = stat()
  guard fstat(0, &st) == 0, (st.st_mode & S_IFMT) == S_IFSOCK else { return no("stdin is not a socket") }
  var token = audit_token_t()
  var len = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(0, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) == 0, len == socklen_t(MemoryLayout<audit_token_t>.size) else {
    return no("stdin has no peer token (errno \(errno))")
  }
  // audit_token_to_pid / _pidversion (libbsm) read these two words; reading
  // them here keeps the helper free of a libbsm link.
  let pid = pid_t(bitPattern: token.val.5)
  let pidVersion = Int32(bitPattern: token.val.7)
  if pid <= 1 { return no("stdin peer is pid \(pid)") }
  let tokenData = withUnsafeBytes(of: &token) { Data($0) }

  var req: SecRequirement?
  guard SecRequirementCreateWithString(reqText as CFString, [], &req) == errSecSuccess, let requirement = req else {
    return no("requirement did not compile")
  }

  /// Resolves the token and checks requirement + hardened runtime; nil = ok.
  func verify() -> String? {
    var code: SecCode?
    let attrs = [kSecGuestAttributeAudit: tokenData] as CFDictionary
    var s = SecCodeCopyGuestWithAttributes(nil, attrs, [], &code)
    guard s == errSecSuccess, let peer = code else { return "peer \(pid) not found by audit token (\(s))" }
    s = SecCodeCheckValidity(peer, [], requirement)
    if s != errSecSuccess { return "peer \(pid) is not \(label) signed as required (\(s))" }
    var info: CFDictionary?
    s = SecCodeCopySigningInformation(unsafeBitCast(peer, to: SecStaticCode.self),
                                      SecCSFlags(rawValue: kSecCSDynamicInformation), &info)
    guard s == errSecSuccess, let d = info as? [String: Any],
          let status = (d[kSecCodeInfoStatus as String] as? NSNumber)?.uint32Value else {
      return "peer \(pid) signing status unreadable (\(s))"
    }
    if status & CS_RUNTIME == 0 { return "peer \(pid) does not run with the hardened runtime" }
    return nil
  }

  if let why = verify() { return no(why) }
  guard let env = processEnvironment(pid: pid) else { return no("peer \(pid) environment unreadable") }
  if env.contains(where: { $0.hasPrefix("ELECTRON_RUN_AS_NODE=") }) {
    return no("peer \(pid) runs as plain Node (ELECTRON_RUN_AS_NODE)")
  }
  // Same pid and pid version as the token: the environment we read is that process's.
  if let why = verify() { return no("peer changed during the check: \(why)") }
  PeerPin.pin(pid: pid, version: pidVersion)
  return ParentVerdict(trusted: true, verified: true, detail: "peer \(pid)/\(pidVersion) is \(label)")
}

/// The stdin peer's audit token (pid, pid version), or nil.
func stdinPeer() -> (pid_t, Int32)? {
  var token = audit_token_t()
  var len = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(0, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) == 0 else { return nil }
  // audit_token_to_pid / _pidversion (libbsm) read these two words.
  return (pid_t(bitPattern: token.val.5), Int32(bitPattern: token.val.7))
}

/// The verified parent, pinned for the life of the process (see the header).
enum PeerPin {
  private static var pinned: (pid_t, Int32)?
  /// Release and dev: always. Test flavor: only with CINNA_VAULT_TEST_ENFORCE_PARENT=1.
  static var enforced: Bool = {
    #if VAULT_TEST_GATE
    return false
    #else
    return true
    #endif
  }()

  static func pin(pid: pid_t, version: Int32) { pinned = (pid, version) }

  /// Called by the frame reader after each frame. nil = fine (or not enforced);
  /// otherwise why the helper must stop. Reads `pinned` only after the
  /// verdict has been computed (main.swift evaluates it before reading).
  static func stillPinned() -> String? {
    // No verified parent: the verdict already refuses every method but hello
    // and availability (Control.swift), which stay answerable.
    guard let (pid, version) = pinned else { return nil }
    guard let (p, v) = stdinPeer() else { return enforced ? "stdin peer unreadable" : nil }
    if p == pid && v == version { return nil }
    let why = "stdin peer is now \(p)/\(v), not the verified parent \(pid)/\(version)"
    if enforced { return why }
    logStderr("test flavor, not enforced: \(why)")
    pinned = (p, v)  // log once per change
    return nil
  }
}

/// The launch environment of `pid`, from KERN_PROCARGS2:
/// argc (i32) · exec path \0 · padding \0… · argv[0..argc) \0-separated · env \0-separated · \0.
func processEnvironment(pid: pid_t) -> [String]? {
  var argmax: Int32 = 0
  var size = MemoryLayout<Int32>.size
  var mibMax: [Int32] = [CTL_KERN, KERN_ARGMAX]
  guard sysctl(&mibMax, 2, &argmax, &size, nil, 0) == 0, argmax > 0 else { return nil }
  var buf = [UInt8](repeating: 0, count: Int(argmax))
  var len = buf.count
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  guard sysctl(&mib, 3, &buf, &len, nil, 0) == 0, len > 4 else { return nil }
  let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
  var i = 4
  // exec path
  while i < len && buf[i] != 0 { i += 1 }
  // padding
  while i < len && buf[i] == 0 { i += 1 }
  func next() -> String? {
    guard i < len else { return nil }
    let start = i
    while i < len && buf[i] != 0 { i += 1 }
    let s = String(decoding: buf[start..<i], as: UTF8.self)
    i += 1
    return s
  }
  for _ in 0..<argc { guard next() != nil else { return nil } }
  var env: [String] = []
  while let s = next(), !s.isEmpty { env.append(s) }
  return env
}
