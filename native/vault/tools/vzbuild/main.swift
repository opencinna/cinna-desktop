// vzbuild: runs one Linux VM for the Agent Vault guest image build and boot smoke test.
// Dev-only, never shipped. Built and ad-hoc signed (com.apple.security.virtualization) by
// scripts/vault/build-guest.sh. Adapted from the phase-0 probe helper's `run` mode.
//
//   vzbuild run <config.json>
//
// config: {kernel, initrd, cmdline, disks: [{path, readOnly}], memMB, cpus, nat, console,
//          listen: [{port, unix}],   guest connects to this vsock port -> bridged to a host unix socket
//          connect: [{port, unix}]}  host unix listener -> bridged to a guest vsock port
// stdout: one JSON event per line ({ev, ms, ...}). stdin: `stop` | `pause` | `resume`; EOF stops the VM.
import Foundation
import Virtualization

let t0 = Date()
func ms() -> Int { Int(Date().timeIntervalSince(t0) * 1000) }
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  var o = obj; o["ms"] = ms()
  guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
  outLock.lock(); defer { outLock.unlock() }
  FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data([0x0a]))
}
func die(_ s: String) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(1) }

// MARK: unix sockets

func unixAddr(_ path: String) -> sockaddr_un {
  var a = sockaddr_un(); a.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  if bytes.count >= MemoryLayout.size(ofValue: a.sun_path) { die("unix socket path too long: \(path)") }
  withUnsafeMutableBytes(of: &a.sun_path) { p in for (i, b) in bytes.enumerated() { p[i] = b } }
  return a
}
func unixConnect(_ path: String) -> Int32 {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var a = unixAddr(path)
  let r = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  if r != 0 { close(fd); return -1 }
  return fd
}
func unixListen(_ path: String) -> Int32 {
  unlink(path)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var a = unixAddr(path)
  let r = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
  if r != 0 { die("bind \(path) failed errno \(errno)") }
  listen(fd, 16)
  return fd
}

/// Copies bytes both ways; each direction half-closes its destination at EOF. Calls done once both are finished.
func bridge(_ a: Int32, _ b: Int32, done: @escaping () -> Void) {
  let group = DispatchGroup()
  for (src, dst) in [(a, b), (b, a)] {
    group.enter()
    Thread.detachNewThread {
      var buf = [UInt8](repeating: 0, count: 65536)
      copy: while true {
        let n = read(src, &buf, buf.count)
        if n <= 0 { break }
        var off = 0
        while off < n {
          let w = buf.withUnsafeBytes { write(dst, $0.baseAddress! + off, n - off) }
          if w <= 0 { break copy }
          off += w
        }
      }
      shutdown(dst, SHUT_WR)
      group.leave()
    }
  }
  group.notify(queue: .global()) { done() }
}

// MARK: VM

struct PortMap: Codable { let port: UInt32; let unix: String }
struct Disk: Codable { let path: String; let readOnly: Bool }
struct RunConfig: Codable {
  let kernel: String; let initrd: String; let cmdline: String
  let disks: [Disk]; let memMB: UInt64; let cpus: Int; let nat: Bool
  let console: String
  let listen: [PortMap]
  let connect: [PortMap]
}

final class ListenerDelegate: NSObject, VZVirtioSocketListenerDelegate {
  let unix: String; let port: UInt32
  var live: [ObjectIdentifier: VZVirtioSocketConnection] = [:]
  let lock = NSLock()
  init(unix: String, port: UInt32) { self.unix = unix; self.port = port }
  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection c: VZVirtioSocketConnection, from device: VZVirtioSocketDevice) -> Bool {
    let fd = unixConnect(unix)
    if fd < 0 { emit(["ev": "listen-refused", "port": port]); return false }
    lock.lock(); live[ObjectIdentifier(c)] = c; lock.unlock()
    bridge(c.fileDescriptor, fd) { [weak self] in
      close(fd); c.close()
      self?.lock.lock(); self?.live[ObjectIdentifier(c)] = nil; self?.lock.unlock()
    }
    return true
  }
}

final class VMDelegate: NSObject, VZVirtualMachineDelegate {
  func guestDidStop(_ vm: VZVirtualMachine) { emit(["ev": "guest-stopped"]); exit(0) }
  func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { emit(["ev": "error", "error": "\(error)"]); exit(2) }
}

var keep: [AnyObject] = []

func runVM(_ cfgPath: String) {
  let cfg: RunConfig
  do { cfg = try JSONDecoder().decode(RunConfig.self, from: Data(contentsOf: URL(fileURLWithPath: cfgPath))) } catch { die("config: \(error)") }
  let c = VZVirtualMachineConfiguration()
  let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: cfg.kernel))
  boot.initialRamdiskURL = URL(fileURLWithPath: cfg.initrd)
  boot.commandLine = cfg.cmdline
  c.bootLoader = boot
  c.cpuCount = cfg.cpus
  c.memorySize = cfg.memMB * 1024 * 1024
  c.platform = VZGenericPlatformConfiguration()
  FileManager.default.createFile(atPath: cfg.console, contents: nil)
  guard let consoleHandle = FileHandle(forWritingAtPath: cfg.console) else { die("console \(cfg.console)") }
  let con = VZVirtioConsoleDeviceSerialPortConfiguration()
  con.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: consoleHandle)
  c.serialPorts = [con]
  c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
  do {
    c.storageDevices = try cfg.disks.map { d in
      VZVirtioBlockDeviceConfiguration(attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: d.path), readOnly: d.readOnly))
    }
  } catch { emit(["ev": "invalid", "error": "disk: \(error)"]); exit(3) }
  if cfg.nat {
    let n = VZVirtioNetworkDeviceConfiguration(); n.attachment = VZNATNetworkDeviceAttachment()
    c.networkDevices = [n]
  }
  c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
  do { try c.validate() } catch { emit(["ev": "invalid", "error": "\(error)"]); exit(3) }

  let vm = VZVirtualMachine(configuration: c)
  let del = VMDelegate(); vm.delegate = del; keep.append(del)
  guard let sock = vm.socketDevices.first as? VZVirtioSocketDevice else { die("no vsock device") }
  for m in cfg.listen {
    let l = VZVirtioSocketListener(); let d = ListenerDelegate(unix: m.unix, port: m.port)
    l.delegate = d; keep.append(l); keep.append(d)
    sock.setSocketListener(l, forPort: m.port)
  }
  for m in cfg.connect {
    let lfd = unixListen(m.unix)
    Thread.detachNewThread {
      while true {
        let cfd = accept(lfd, nil, nil)
        if cfd < 0 { continue }
        DispatchQueue.main.async {
          sock.connect(toPort: m.port) { result in
            switch result {
            case .success(let conn):
              keep.append(conn)
              bridge(conn.fileDescriptor, cfd) { close(cfd); conn.close() }
            case .failure(let e):
              emit(["ev": "connect-failed", "port": m.port, "error": "\(e)"]); close(cfd)
            }
          }
        }
      }
    }
  }
  emit(["ev": "starting"])
  vm.start { r in
    switch r {
    case .success: emit(["ev": "running"])
    case .failure(let e): emit(["ev": "start-failed", "error": "\(e)"]); exit(4)
    }
  }
  // stdin control; EOF (the parent went away) stops the VM.
  Thread.detachNewThread {
    while let line = readLine() {
      let cmd = line.trimmingCharacters(in: .whitespaces)
      DispatchQueue.main.async {
        let s = ms()
        switch cmd {
        case "pause": vm.pause { r in emit(["ev": "paused", "ok": (try? r.get()) != nil, "took": ms() - s]) }
        case "resume": vm.resume { r in emit(["ev": "resumed", "ok": (try? r.get()) != nil, "took": ms() - s]) }
        case "stop": vm.stop { e in emit(["ev": "stopped", "error": e.map { "\($0)" } ?? ""]); exit(0) }
        default: emit(["ev": "unknown-cmd", "cmd": cmd])
        }
      }
    }
    DispatchQueue.main.async {
      if vm.canStop { vm.stop { _ in emit(["ev": "stopped", "reason": "stdin-eof"]); exit(0) } } else { exit(0) }
    }
  }
  keep.append(vm)
}

let a = CommandLine.arguments
if a.count == 3 && a[1] == "run" { runVM(a[2]); dispatchMain() }
die("usage: vzbuild run <config.json>")
