// Small shared pieces: secret buffers, encodings, blocking socket I/O, logging.
import CryptoKit
import Darwin
import Foundation

/// A key held in a buffer we can overwrite. Swift gives no hard guarantee that
/// no copy was made elsewhere (CryptoKit, Data CoW), so this is best effort:
/// every copy we own is zeroed as soon as it has been used.
final class SecretBytes {
  private(set) var bytes: [UInt8]
  init(_ bytes: [UInt8]) { self.bytes = bytes }
  init(random count: Int) {
    bytes = [UInt8](repeating: 0, count: count)
    let st = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    precondition(st == errSecSuccess, "SecRandomCopyBytes failed")
  }
  var count: Int { bytes.count }
  var isZeroed: Bool { bytes.allSatisfy { $0 == 0 } }
  func zero() {
    bytes.withUnsafeMutableBytes { p in
      if let base = p.baseAddress { memset_s(base, p.count, 0, p.count) }
    }
  }
  deinit { zero() }
}

/// Overwrites a Data in place (its storage, if uniquely owned, is ours).
func zeroData(_ d: inout Data) {
  d.withUnsafeMutableBytes { p in
    if let base = p.baseAddress { memset_s(base, p.count, 0, p.count) }
  }
}

func randomBytes(_ n: Int) -> [UInt8] {
  var b = [UInt8](repeating: 0, count: n)
  precondition(SecRandomCopyBytes(kSecRandomDefault, n, &b) == errSecSuccess)
  return b
}

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

private let hexDigits = Array("0123456789abcdef".utf8)
func hexBytes<C: Collection>(_ b: C) -> [UInt8] where C.Element == UInt8 {
  var out = [UInt8](); out.reserveCapacity(b.count * 2)
  for x in b { out.append(hexDigits[Int(x >> 4)]); out.append(hexDigits[Int(x & 15)]) }
  return out
}
func hex<C: Collection>(_ b: C) -> String where C.Element == UInt8 { String(decoding: hexBytes(b), as: UTF8.self) }
func unhex(_ s: String) -> [UInt8]? {
  let u = Array(s.utf8)
  guard u.count % 2 == 0 else { return nil }
  func v(_ c: UInt8) -> UInt8? {
    switch c {
    case 48...57: return c - 48
    case 97...102: return c - 87
    case 65...70: return c - 55
    default: return nil
    }
  }
  var out = [UInt8](); out.reserveCapacity(u.count / 2)
  var i = 0
  while i < u.count {
    guard let hi = v(u[i]), let lo = v(u[i + 1]) else { return nil }
    out.append(hi << 4 | lo); i += 2
  }
  return out
}

func base64url(_ d: Data) -> String {
  d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}
func unbase64url(_ s: String) -> Data? {
  var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while t.count % 4 != 0 { t += "=" }
  return Data(base64Encoded: t)
}

func sha256Hex(_ s: String) -> String { hex(Array(SHA256.hash(data: Data(s.utf8)))) }
func sha256Hex(_ d: Data) -> String { hex(Array(SHA256.hash(data: d))) }

/// Constant-time comparison for MACs.
func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
  guard a.count == b.count else { return false }
  var diff: UInt8 = 0
  for i in 0..<a.count { diff |= a[i] ^ b[i] }
  return diff == 0
}

// MARK: logging (stderr only: stdout carries frames)

func logStderr(_ s: String) {
  let line = "vault-helper: " + s + "\n"
  line.withCString { p in _ = write(2, p, strlen(p)) }
}

// MARK: blocking fd I/O

/// Writes everything or returns false (EPIPE, reset, closed).
@discardableResult
func writeAll(_ fd: Int32, _ bytes: UnsafeRawBufferPointer) -> Bool {
  guard let base = bytes.baseAddress else { return true }
  var off = 0
  while off < bytes.count {
    let w = write(fd, base + off, bytes.count - off)
    if w < 0 {
      if errno == EINTR { continue }
      return false
    }
    if w == 0 { return false }
    off += w
  }
  return true
}
@discardableResult
func writeAll(_ fd: Int32, _ bytes: [UInt8]) -> Bool { bytes.withUnsafeBytes { writeAll(fd, $0) } }

/// Reads exactly `count` bytes; nil on EOF or error.
func readExact(_ fd: Int32, _ count: Int) -> [UInt8]? {
  var buf = [UInt8](repeating: 0, count: count)
  var off = 0
  while off < count {
    let n = buf.withUnsafeMutableBytes { p in read(fd, p.baseAddress! + off, count - off) }
    if n < 0 {
      if errno == EINTR { continue }
      return nil
    }
    if n == 0 { return nil }
    off += n
  }
  return buf
}

/// Waits until fd is readable; false on timeout or error.
func waitReadable(_ fd: Int32, timeoutMs: Int) -> Bool {
  var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
  while true {
    let r = poll(&p, 1, Int32(timeoutMs))
    if r < 0 && errno == EINTR { continue }
    return r > 0
  }
}

/// Reads one `\n`-terminated line (without the newline) with an overall deadline.
func readSocketLine(_ fd: Int32, timeoutMs: Int, maxBytes: Int = 64 * 1024) -> String? {
  let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
  var out = [UInt8]()
  var byte: UInt8 = 0
  while true {
    let left = Int(deadline.timeIntervalSinceNow * 1000)
    if left <= 0 || !waitReadable(fd, timeoutMs: left) { return nil }
    let n = read(fd, &byte, 1)
    if n < 0 && errno == EINTR { continue }
    if n <= 0 { return nil }
    if byte == 10 { return String(decoding: out, as: UTF8.self) }
    out.append(byte)
    if out.count > maxBytes { return nil }
  }
}

func jsonBytes(_ obj: Any) -> [UInt8] {
  // Every object we serialise is a JSON container built from JSON types.
  let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])
  return [UInt8](d)
}

func parseJSONObject(_ s: String) -> [String: Any]? {
  guard let d = s.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}

// MARK: sysctl

func sysctlInt(_ name: String) -> Int? {
  var v: Int32 = 0
  var size = MemoryLayout<Int32>.size
  if sysctlbyname(name, &v, &size, nil, 0) == 0 { return Int(v) }
  var v64: Int64 = 0
  size = MemoryLayout<Int64>.size
  if sysctlbyname(name, &v64, &size, nil, 0) == 0 { return Int(v64) }
  return nil
}

// MARK: display text

/// Text a caller supplied, made safe to put in a system prompt: control, format
/// (bidi overrides, zero-width) and line/paragraph separators dropped, quotes
/// replaced so it cannot close the helper's own quotation marks, whitespace
/// collapsed, and the length capped.
func sanitizeForPrompt(_ s: String, max: Int) -> String {
  var out = ""
  var lastSpace = false
  for scalar in s.unicodeScalars {
    switch scalar.properties.generalCategory {
    case .format, .surrogate, .privateUse, .unassigned:
      continue  // bidi overrides, zero-width joiners and the like: dropped
    case .spaceSeparator, .control, .lineSeparator, .paragraphSeparator:  // newlines and tabs read as a space
      if !lastSpace && !out.isEmpty { out.append(" ") }
      lastSpace = true
      continue
    default: break
    }
    lastSpace = false
    switch scalar {
    case "\"", "\u{201C}", "\u{201D}", "\u{201E}", "\u{00AB}", "\u{00BB}": out.append("'")
    default: out.unicodeScalars.append(scalar)
    }
  }
  out = out.trimmingCharacters(in: .whitespaces)
  if out.count > max { out = String(out.prefix(max - 1)) + "…" }
  return out
}
