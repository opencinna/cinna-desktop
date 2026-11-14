// Stdio frames (spec §1, protocol.ts HELPER_FRAME_*):
// u32 BE length (of type + channel + payload) · u8 type · u32 BE channel · payload.
import Darwin
import Foundation

enum FrameType: UInt8 {
  case ctl = 0, data = 1, eof = 2, rst = 3
}

let FRAME_HEADER_BYTES = 9
let FRAME_MAX_PAYLOAD = 256 * 1024

func encodeFrame(_ type: FrameType, _ channel: UInt32, _ payload: UnsafeRawBufferPointer) -> [UInt8] {
  let len = UInt32(5 + payload.count)
  var out = [UInt8](); out.reserveCapacity(4 + Int(len))
  out += [UInt8(len >> 24), UInt8((len >> 16) & 0xff), UInt8((len >> 8) & 0xff), UInt8(len & 0xff)]
  out.append(type.rawValue)
  out += [UInt8(channel >> 24), UInt8((channel >> 16) & 0xff), UInt8((channel >> 8) & 0xff), UInt8(channel & 0xff)]
  out += payload
  return out
}

func beU32(_ b: [UInt8], _ at: Int) -> UInt32 {
  var v: UInt32 = 0
  for i in 0..<4 { v = (v << 8) | UInt32(b[at + i]) }
  return v
}

/// The only writer of fd 1. One serial queue keeps frames whole and in order.
final class FrameWriter {
  static let shared = FrameWriter(fd: 1)
  private let fd: Int32
  private let q = DispatchQueue(label: "vault.frames.out")
  private var broken = false
  var onBroken: (() -> Void)?

  init(fd: Int32) { self.fd = fd }

  private func put(_ bytes: [UInt8]) {
    if broken { return }
    if !writeAll(fd, bytes) {
      broken = true
      let cb = onBroken
      DispatchQueue.main.async { cb?() }
    }
  }

  /// Control and events: never blocks the caller.
  func sendControl(_ obj: Any) {
    let payload = jsonBytes(obj)
    q.async { self.put(payload.withUnsafeBytes { encodeFrame(.ctl, 0, $0) }) }
  }

  func send(_ type: FrameType, _ channel: UInt32, _ payload: [UInt8] = []) {
    q.async { self.put(payload.withUnsafeBytes { encodeFrame(type, channel, $0) }) }
  }

  /// Channel data from a reader thread: blocks until written, so a slow parent
  /// pushes back on the guest instead of growing a queue here.
  func sendDataSync(_ channel: UInt32, _ bytes: UnsafeRawBufferPointer) {
    var off = 0
    while off < bytes.count {
      let n = min(FRAME_MAX_PAYLOAD, bytes.count - off)
      let frame = encodeFrame(.data, channel, UnsafeRawBufferPointer(rebasing: bytes[off..<(off + n)]))
      q.sync { self.put(frame) }
      off += n
    }
  }

  func flush() { q.sync {} }
}

/// Reads frames from fd 0 on its own thread and hands them to `onFrame` on the main queue.
final class FrameReader {
  private let fd: Int32
  let onFrame: (FrameType, UInt32, [UInt8]) -> Void
  let onEnd: (String?) -> Void

  init(fd: Int32, onFrame: @escaping (FrameType, UInt32, [UInt8]) -> Void, onEnd: @escaping (String?) -> Void) {
    self.fd = fd; self.onFrame = onFrame; self.onEnd = onEnd
  }

  func start() {
    let t = Thread { [self] in run() }
    t.name = "vault.frames.in"
    t.start()
  }

  private func run() {
    while true {
      guard let head = readExact(fd, 4) else { end(nil); return }
      let len = Int(beU32(head, 0))
      if len < 5 || len > 5 + FRAME_MAX_PAYLOAD { end("frame length \(len) out of range"); return }
      guard let body = readExact(fd, len) else { end(nil); return }
      guard let type = FrameType(rawValue: body[0]) else { end("unknown frame type \(body[0])"); return }
      // D35: the frame's sender must still be the verified parent (ParentCheck.swift).
      if let why = PeerPin.stillPinned() { end("untrusted: \(why)"); return }
      let channel = beU32(body, 1)
      let payload = Array(body[5...])
      // Main serialises control; data frames are routed to per-channel write
      // queues from there, so the order of frames on one channel is kept.
      DispatchQueue.main.async { self.onFrame(type, channel, payload) }
    }
  }

  private func end(_ error: String?) {
    DispatchQueue.main.async { self.onEnd(error) }
  }
}
