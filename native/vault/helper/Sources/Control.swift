// Channel-0 control: `{id, method, params}` → `{id, result}` | `{id, error:{code, message}}`;
// events `{event, ...}`. Everything here runs on the main queue.
import Foundation

struct HelperError: Error {
  let code: String
  let message: String
  static func invalid(_ m: String) -> HelperError { HelperError(code: "invalid", message: m) }
}

typealias Reply = (Any?, HelperError?) -> Void

enum Control {
  static func emit(_ event: [String: Any]) { FrameWriter.shared.sendControl(event) }

  static func emitLog(_ level: String, _ message: String) {
    emit(["event": "log", "level": level, "message": message])
  }

  static func handle(_ payload: [UInt8]) {
    guard let obj = (try? JSONSerialization.jsonObject(with: Data(payload))) as? [String: Any] else {
      emitLog("warn", "dropped a control frame that is not a JSON object")
      return
    }
    guard let id = obj["id"], let method = obj["method"] as? String else {
      emitLog("warn", "dropped a control frame without id or method")
      return
    }
    let params = obj["params"] as? [String: Any] ?? [:]
    var replied = false
    let reply: Reply = { result, error in
      if replied { return }
      replied = true
      if let e = error {
        FrameWriter.shared.sendControl(["id": id, "error": ["code": e.code, "message": e.message]])
      } else {
        FrameWriter.shared.sendControl(["id": id, "result": result ?? [String: Any]()])
      }
    }
    // D26: an untrusted parent learns only that it is untrusted. `hello` stays
    // answerable so the caller can tell a refusing helper from a broken one.
    if !parentVerdict.trusted && method != "availability" && method != "hello" {
      reply(nil, HelperError(code: "unavailable", message: "helper-untrusted"))
      return
    }
    VaultManager.shared.dispatch(method: method, params: params, reply: reply)
  }
}

// MARK: param access

extension Dictionary where Key == String, Value == Any {
  func str(_ k: String) throws -> String {
    guard let v = self[k] as? String else { throw HelperError.invalid("\(k) must be a string") }
    return v
  }
  func int64(_ k: String) throws -> Int64 {
    guard let n = self[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else {
      throw HelperError.invalid("\(k) must be a number")
    }
    let d = n.doubleValue
    guard d.rounded() == d, abs(d) < 9.0e15 else { throw HelperError.invalid("\(k) must be an integer") }
    return n.int64Value
  }
  func hosts(_ k: String) throws -> [String] {
    guard let o = self[k] as? [String: Any], let hs = o["hosts"] as? [String] else {
      throw HelperError.invalid("\(k) must be {hosts: string[]}")
    }
    guard hs.count <= 200 else { throw HelperError.invalid("too many hosts") }
    let canon = canonicalHosts(hs)
    for h in canon where !isValidHostPattern(h) {
      throw HelperError.invalid("not a host name: \(sanitizeForPrompt(h, max: 80))")
    }
    return canon
  }
}
