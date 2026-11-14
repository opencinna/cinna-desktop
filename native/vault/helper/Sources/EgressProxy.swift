// The guest's only way out (spec §2, D18): an HTTP CONNECT proxy on vsock 1080.
//
// - CONNECT only; anything else gets 405.
// - Port 443 only. Port 80 is refused too: every engine and install host is
//   HTTPS, plain HTTP would carry whatever the agent sends in clear over the
//   user's network, and an allowlisted host is not a reason to open a second,
//   unencrypted path to it.
// - The target must be a DNS name (IP literals, including inet_aton's odd forms,
//   get 403) on the vault's allowlist, or on VAULT_INSTALL_HOSTS for a CONNECT
//   that carries `Proxy-Authorization: Basic base64("cinna:<cred>")` of a live
//   install credential (D37). A move-in/install approval mints one; vaultd hands
//   it only to the exec that token authorizes. It dies at the token's expiry, on
//   lock or stop, or when vaultd reports that exec's end (VaultVM subscription);
//   tunnels it opened are cut then. The vault's own allowlist needs no
//   credential. `*.x.com` matches subdomains only. The header is never
//   forwarded: the proxy terminates the CONNECT and relays only the tunnel.
// - The helper resolves the name and connects itself, and never to loopback,
//   link-local, multicast or unspecified addresses, so an allowlisted name that
//   resolves to 127.0.0.1 cannot reach services on this Mac. Private LAN ranges
//   stay reachable: a user may allowlist a company host.
import Darwin
import Foundation
import Virtualization

final class EgressProxy: NSObject, VZVirtioSocketListenerDelegate {
  let vaultId: String
  /// Current allowlist; read on proxy threads, so behind a lock.
  private let lock = NSLock()
  private var hosts: [String]
  /// Live install credentials (32 hex) → expiry (epoch ms).
  private var creds: [String: Int64] = [:]
  private var live: [ObjectIdentifier: VZVirtioSocketConnection] = [:]
  /// Tunnels to install hosts, by the credential that opened them.
  private var credTunnels: [String: [ObjectIdentifier]] = [:]
  let listener = VZVirtioSocketListener()

  init(vaultId: String, hosts: [String]) {
    self.vaultId = vaultId
    self.hosts = hosts
    super.init()
    listener.delegate = self
  }

  func setHosts(_ h: [String]) { lock.lock(); hosts = h; lock.unlock() }

  /// A fresh install credential valid until `until` (the approval token's exp).
  func mintCred(until: Int64) -> String {
    let cred = hex(randomBytes(16))
    lock.lock(); creds[cred] = until; lock.unlock()
    return cred
  }

  /// Revokes one credential (exec ended) and cuts the tunnels it opened.
  func revoke(_ cred: String) {
    lock.lock()
    let known = creds.removeValue(forKey: cred) != nil
    let conns = (credTunnels.removeValue(forKey: cred) ?? []).compactMap { live[$0] }
    lock.unlock()
    for c in conns { shutdown(c.fileDescriptor, SHUT_RDWR) }
    if known { logStderr("vault \(vaultId): install credential revoked (\(conns.count) tunnel(s) cut)") }
  }

  /// Revokes every credential (lock, stop) and cuts their tunnels.
  func revokeAll() {
    lock.lock()
    let ids = credTunnels.values.flatMap { $0 }
    let conns = ids.compactMap { live[$0] }
    creds.removeAll(); credTunnels.removeAll()
    lock.unlock()
    for c in conns { shutdown(c.fileDescriptor, SHUT_RDWR) }
  }

  var liveCredCount: Int { lock.lock(); defer { lock.unlock() }; return creds.count }

  /// nil = refused; "" = the vault's own allowlist; else the credential that opened an install host.
  func allowed(_ host: String, presented: String?) -> String? {
    lock.lock()
    let list = hosts
    let now = nowMs()
    creds = creds.filter { $0.value > now }
    var match: String?
    if let p = presented {
      // Compare against every live credential, in constant time each.
      let pb = Array(p.utf8)
      for c in creds.keys where constantTimeEqual(Array(c.utf8), pb) { match = c }
    }
    lock.unlock()
    if EgressProxy.matches(host, list) { return "" }
    if let m = match, EgressProxy.matches(host, VAULT_INSTALL_HOSTS) { return m }
    return nil
  }

  private func forget(_ conn: VZVirtioSocketConnection) {
    let id = ObjectIdentifier(conn)
    lock.lock()
    live[id] = nil
    for (k, v) in credTunnels where v.contains(id) { credTunnels[k] = v.filter { $0 != id } }
    lock.unlock()
  }

  private func track(_ conn: VZVirtioSocketConnection, cred: String) {
    lock.lock(); credTunnels[cred, default: []].append(ObjectIdentifier(conn)); lock.unlock()
  }

  /// The credential in a `Proxy-Authorization: Basic base64("cinna:<cred>")` header, if well formed.
  static func presentedCred(_ head: [UInt8]) -> String? {
    let text = String(decoding: head, as: UTF8.self)
    for line in text.components(separatedBy: "\r\n").dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      guard line[..<colon].trimmingCharacters(in: .whitespaces).lowercased() == "proxy-authorization" else { continue }
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      let parts = value.split(separator: " ", maxSplits: 1)
      guard parts.count == 2, parts[0].lowercased() == "basic",
            let d = Data(base64Encoded: String(parts[1]).trimmingCharacters(in: .whitespaces)) else { return nil }
      let pair = String(decoding: d, as: UTF8.self)
      guard pair.hasPrefix("cinna:") else { return nil }
      let cred = String(pair.dropFirst(6))
      guard cred.count == 32, cred.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
      return cred
    }
    return nil
  }

  static func matches(_ host: String, _ patterns: [String]) -> Bool {
    for p in patterns {
      if p.hasPrefix("*.") {
        let suffix = String(p.dropFirst(1))  // ".x.com"
        if host.count > suffix.count && host.hasSuffix(suffix) { return true }
      } else if host == p {
        return true
      }
    }
    return false
  }

  /// Closes every live tunnel and drops every credential (cold stop).
  func closeAll() {
    lock.lock(); let conns = Array(live.values); live.removeAll(); creds.removeAll(); credTunnels.removeAll(); lock.unlock()
    for c in conns { shutdown(c.fileDescriptor, SHUT_RDWR) }
  }

  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                from socketDevice: VZVirtioSocketDevice) -> Bool {
    lock.lock(); live[ObjectIdentifier(connection)] = connection; lock.unlock()
    let t = Thread { [weak self] in
      self?.serve(connection)
      self?.forget(connection)
      connection.close()
    }
    t.name = "vault.egress"
    t.start()
    return true
  }

  private func respond(_ fd: Int32, _ status: String) {
    writeAll(fd, Array("HTTP/1.1 \(status)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
  }

  private func report(_ host: String, _ verdict: String) {
    let id = vaultId
    DispatchQueue.main.async { Control.emit(["event": "egress", "vaultId": id, "host": host, "verdict": verdict]) }
  }

  private func serve(_ conn: VZVirtioSocketConnection) {
    let fd = conn.fileDescriptor
    // Request head: at most 8 KiB, within 30 s.
    var head = [UInt8]()
    var byte = [UInt8](repeating: 0, count: 4096)
    let deadline = Date().addingTimeInterval(30)
    var bodyStart = -1
    while bodyStart < 0 {
      let left = Int(deadline.timeIntervalSinceNow * 1000)
      if left <= 0 || !waitReadable(fd, timeoutMs: left) { return }
      let n = read(fd, &byte, byte.count)
      if n <= 0 { return }
      head += byte[0..<n]
      if let r = findHeadEnd(head) { bodyStart = r }
      else if head.count > 8192 { respond(fd, "431 Request Header Fields Too Large"); return }
    }
    let early = Array(head[bodyStart...])
    let line = String(decoding: head.prefix(while: { $0 != 13 && $0 != 10 }), as: UTF8.self)
    let parts = line.split(separator: " ")
    guard parts.count == 3, parts[0] == "CONNECT" else { respond(fd, "405 Method Not Allowed"); return }
    let target = String(parts[1])
    guard let colon = target.lastIndex(of: ":"), let port = Int(target[target.index(after: colon)...]) else {
      respond(fd, "400 Bad Request"); return
    }
    var host = String(target[..<colon]).lowercased()
    if host.hasSuffix(".") { host.removeLast() }
    let shown = sanitizeForPrompt(host, max: 253)
    if port != 443 || host.hasPrefix("[") || isIPLiteral(host) || !isValidHostPattern(host) || host.hasPrefix("*.") {
      report(shown + (port != 443 ? ":\(port)" : ""), "denied"); respond(fd, "403 Forbidden"); return
    }
    guard let via = allowed(host, presented: EgressProxy.presentedCred(Array(head[..<bodyStart]))) else {
      report(host, "denied"); respond(fd, "403 Forbidden"); return
    }
    if !via.isEmpty { track(conn, cred: via) }
    guard let up = connectPublic(host: host, port: port) else {
      report(host, "denied"); respond(fd, "502 Bad Gateway"); return
    }
    // Revoked while connecting: the tunnel no longer exists in credTunnels.
    if !via.isEmpty {
      lock.lock(); let still = creds[via] != nil; lock.unlock()
      if !still { close(up); report(host, "denied"); respond(fd, "403 Forbidden"); return }
    }
    report(host, "allowed")
    respond200(fd)
    if !early.isEmpty && !writeAll(up, early) { close(up); return }
    pump(fd, up)
    close(up)
  }

  private func respond200(_ fd: Int32) {
    writeAll(fd, Array("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
  }

  private func findHeadEnd(_ b: [UInt8]) -> Int? {
    guard b.count >= 4 else { return nil }
    for i in 0...(b.count - 4) where b[i] == 13 && b[i + 1] == 10 && b[i + 2] == 13 && b[i + 3] == 10 { return i + 4 }
    return nil
  }

  /// Two pumping threads; returns when both directions ended.
  private func pump(_ a: Int32, _ b: Int32) {
    let group = DispatchGroup()
    for (src, dst) in [(a, b), (b, a)] {
      group.enter()
      let t = Thread {
        var buf = [UInt8](repeating: 0, count: 65536)
        while true {
          let n = read(src, &buf, buf.count)
          if n < 0 && errno == EINTR { continue }
          if n <= 0 { break }
          if !buf.withUnsafeBytes({ writeAll(dst, UnsafeRawBufferPointer(rebasing: $0[0..<n])) }) { break }
        }
        shutdown(dst, SHUT_WR)
        shutdown(src, SHUT_RD)
        group.leave()
      }
      t.start()
    }
    group.wait()
  }
}

func isIPLiteral(_ host: String) -> Bool {
  if host.contains(":") { return true }
  var a4 = in_addr()
  if inet_aton(host, &a4) != 0 { return true }
  if let last = host.split(separator: ".").last, last.allSatisfy({ $0.isNumber || $0 == "x" }) { return true }
  return false
}

/// Addresses the proxy never connects to, whatever name resolved there.
func isForbiddenAddress(_ sa: UnsafePointer<sockaddr>) -> Bool {
  if sa.pointee.sa_family == sa_family_t(AF_INET) {
    let a = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
    let o1 = a >> 24, o2 = (a >> 16) & 0xff
    return o1 == 0 || o1 == 127 || (o1 == 169 && o2 == 254) || o1 >= 224
  }
  if sa.pointee.sa_family == sa_family_t(AF_INET6) {
    let b: [UInt8] = sa.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { p in
      withUnsafeBytes(of: p.pointee.sin6_addr) { Array($0) }
    }
    if b.allSatisfy({ $0 == 0 }) { return true }  // ::
    if b[0..<15].allSatisfy({ $0 == 0 }) && b[15] == 1 { return true }  // ::1
    if b[0] == 0xfe && (b[1] & 0xc0) == 0x80 { return true }  // fe80::/10
    if b[0] == 0xff { return true }  // multicast
    // IPv4-mapped / compatible: judge the embedded IPv4 address.
    if b[0..<10].allSatisfy({ $0 == 0 }) && ((b[10] == 0xff && b[11] == 0xff) || (b[10] == 0 && b[11] == 0)) {
      let o1 = b[12], o2 = b[13]
      return o1 == 0 || o1 == 127 || (o1 == 169 && o2 == 254) || o1 >= 224
    }
    return false
  }
  return true
}

/// Resolves and connects (10 s per address), skipping forbidden addresses. -1 → nil.
func connectPublic(host: String, port: Int) -> Int32? {
  var hints = addrinfo(ai_flags: AI_ADDRCONFIG, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM, ai_protocol: IPPROTO_TCP,
                       ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
  var res: UnsafeMutablePointer<addrinfo>?
  guard getaddrinfo(host, String(port), &hints, &res) == 0, let first = res else { return nil }
  defer { freeaddrinfo(first) }
  var cur: UnsafeMutablePointer<addrinfo>? = first
  while let ai = cur {
    cur = ai.pointee.ai_next
    guard let addr = ai.pointee.ai_addr, !isForbiddenAddress(addr) else { continue }
    let fd = socket(ai.pointee.ai_family, ai.pointee.ai_socktype, ai.pointee.ai_protocol)
    if fd < 0 { continue }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    let flags = fcntl(fd, F_GETFL)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    var ok = connect(fd, addr, ai.pointee.ai_addrlen) == 0
    if !ok && errno == EINPROGRESS {
      var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      if poll(&p, 1, 10_000) == 1 {
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        ok = err == 0
      }
    }
    if ok {
      _ = fcntl(fd, F_SETFL, flags)
      return fd
    }
    close(fd)
  }
  return nil
}
