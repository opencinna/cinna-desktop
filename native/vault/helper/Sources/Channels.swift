// channel.open: one vsock connection to guest port 5000 per channel, bridged to
// data / eof / rst frames. A channel outlives a lock (the VM is paused and the
// connection stalls, D19); it is reset when the VM stops.
import Darwin
import Foundation
import Virtualization

final class Channel {
  let id: UInt32
  let vaultId: String
  private let conn: VZVirtioSocketConnection
  private let fd: Int32
  private let wq: DispatchQueue
  private let lock = NSLock()
  private var closed = false
  private var readerExited = false
  private var writeDone = false
  private var finished = false
  var onFinished: ((UInt32) -> Void)?

  init(id: UInt32, vaultId: String, conn: VZVirtioSocketConnection) {
    self.id = id
    self.vaultId = vaultId
    self.conn = conn
    self.fd = conn.fileDescriptor
    self.wq = DispatchQueue(label: "vault.channel.\(id)")
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  }

  func start() {
    let t = Thread { [self] in readLoop() }
    t.name = "vault.channel.\(id).read"
    t.start()
  }

  private func readLoop() {
    var buf = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &buf, buf.count)
      if n < 0 && errno == EINTR { continue }
      if isClosed { break }
      if n > 0 {
        buf.withUnsafeBytes { FrameWriter.shared.sendDataSync(id, UnsafeRawBufferPointer(rebasing: $0[0..<n])) }
        continue
      }
      if n == 0 { FrameWriter.shared.send(.eof, id) } else { reset("guest connection failed (errno \(errno))", notify: true) }
      break
    }
    lock.lock(); readerExited = true; lock.unlock()
    tryFinish()
  }

  private var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

  /// Bytes from main → guest, in frame order.
  func write(_ bytes: [UInt8]) {
    wq.async { [self] in
      if isClosed { return }
      if !writeAll(fd, bytes) { reset("guest connection closed", notify: true) }
    }
  }

  /// Main half-closed its side.
  func eof() {
    wq.async { [self] in
      shutdown(fd, SHUT_WR)
      lock.lock(); writeDone = true; lock.unlock()
      tryFinish()
    }
  }

  /// Kills the channel both ways. `notify` sends rst to main (it did not ask for this).
  func reset(_ reason: String, notify: Bool) {
    lock.lock()
    if closed { lock.unlock(); return }
    closed = true
    lock.unlock()
    if notify { FrameWriter.shared.send(.rst, id, Array(reason.utf8)) }
    shutdown(fd, SHUT_RDWR)
    tryFinish()
  }

  /// Releases the connection once the reader has stopped and nothing more will be written.
  private func tryFinish() {
    lock.lock()
    let ready = readerExited && (writeDone || closed) && !finished
    if ready { finished = true }
    lock.unlock()
    guard ready else { return }
    wq.async { [self] in
      conn.close()
      let cb = onFinished
      DispatchQueue.main.async { cb?(self.id) }
    }
  }
}

/// Main-queue registry of open channels.
enum Channels {
  private static var nextId: UInt32 = 1
  static var open: [UInt32: Channel] = [:]

  static func add(vaultId: String, conn: VZVirtioSocketConnection) -> UInt32 {
    let id = nextId
    nextId = nextId == UInt32.max ? 1 : nextId + 1
    let ch = Channel(id: id, vaultId: vaultId, conn: conn)
    ch.onFinished = { open[$0] = nil }
    open[id] = ch
    return id
  }

  static func start(_ id: UInt32) { open[id]?.start() }

  static func frame(_ type: FrameType, _ id: UInt32, _ payload: [UInt8]) {
    guard let ch = open[id] else {
      if type != .rst { FrameWriter.shared.send(.rst, id, Array("unknown channel".utf8)) }
      return
    }
    switch type {
    case .data: ch.write(payload)
    case .eof: ch.eof()
    case .rst: ch.reset("", notify: false)
    case .ctl: break
    }
  }

  static func resetAll(vaultId: String, reason: String) {
    for ch in open.values where ch.vaultId == vaultId { ch.reset(reason, notify: true) }
  }
}
