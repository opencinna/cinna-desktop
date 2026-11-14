// One vault's VZ virtual machine (D27, D33) and the helper's private ports into it.
//
// Devices: vda = the shared rootfs, attached READ-ONLY (dm-verity in the guest
// checks it against the root hash compiled into this helper), vdb = the vault's
// data.img, virtio vsock, entropy, and a console that goes to a file in the
// vault directory. No network device, no shared folders, no clipboard, no
// graphics or input.
//
// Ports: guest → host 1080 (EgressProxy), 1090 (boot secrets, one connection
// per boot); host → guest 5000 (vaultd: readiness here, everything else is a
// main channel), 5001 (suspend/resume, helper only; plus one long-lived
// `subscribe` connection on which vaultd pushes events, D37; reopened while the
// VM runs, and every install credential is revoked whenever it drops).
//
// One VM per data.img (D40). VZ itself holds an exclusive lock on a read-write
// disk image attachment for the VM's lifetime: with any other flock on the file
// (even our own, in this process) start fails with "the storage device
// attachment is invalid" (measured 2026-11-13). So the helper takes
// flock(LOCK_EX|LOCK_NB) just before building the VM only to refuse, with a
// clear error, a disk another process holds, then lets go for VZ's lock to take
// over. A process that grabs the file in between makes our start fail: still
// never two VMs on one disk.
//
// Key lifetime: the unwrapped disk key exists in the helper only between the
// prompt and its delivery to the guest (the boot message on 1090, or
// `resume` on 5001) and is zeroed right after the write. A paused vault holds
// no key here; the next unlock prompts and unwraps again.
import Darwin
import Foundation
import Virtualization

struct VMError: Error {
  let message: String
}

final class VaultVM: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
  let vaultId: String
  let vm: VZVirtualMachine
  let socket: VZVirtioSocketDevice
  let proxy: EgressProxy
  /// Per boot; the guest keeps it in /run to check guest-verified tokens.
  let approvalKey = SecretBytes(random: 32)
  private let bootListener = VZVirtioSocketListener()
  private let msgLock = NSLock()
  private var bootMessage: SecretBytes?
  private(set) var bootDelivered = false
  private(set) var stopped = false
  var onStop: ((String?) -> Void)?
  /// The 5001 event subscription (main queue).
  private var subscription: VZVirtioSocketConnection?
  private var subscribing = false
  private var stopping = false
  private var subscribeUnsupported = false

  init(vaultId: String, vm: VZVirtualMachine, proxy: EgressProxy) {
    self.vaultId = vaultId
    self.vm = vm
    self.socket = vm.socketDevices[0] as! VZVirtioSocketDevice
    self.proxy = proxy
    super.init()
    vm.delegate = self
    bootListener.delegate = self
    socket.setSocketListener(bootListener, forPort: PORT_BOOT)
    socket.setSocketListener(proxy.listener, forPort: PORT_EGRESS)
  }

  /// Refuses a data.img another process holds locked (a running VM's VZ lock).
  static func probeDiskLock(_ url: URL) throws {
    let fd = open(url.path, O_RDWR | O_CLOEXEC)
    guard fd >= 0 else { throw VMError(message: "cannot open data.img (errno \(errno))") }
    defer { close(fd) }  // releases the lock: VZ takes its own
    if flock(fd, LOCK_EX | LOCK_NB) != 0 {
      let e = errno
      if e == EWOULDBLOCK { throw VMError(message: "another process is using this vault's disk") }
      throw VMError(message: "cannot lock data.img (errno \(e))")
    }
  }

  static func make(doc: VaultDoc, vaultDir: URL, assets: GuestAssets) throws -> VaultVM {
    try probeDiskLock(VaultFiles.dataURL(vaultDir))
    let c = VZVirtualMachineConfiguration()
    let boot = VZLinuxBootLoader(kernelURL: assets.kernel)
    boot.initialRamdiskURL = assets.initrd
    // D36/D39: quiet console, freed and fresh pages zeroed (key material in guest RAM).
    boot.commandLine = "console=hvc0 quiet loglevel=0 init_on_free=1 init_on_alloc=1 vault.time=\(Int(Date().timeIntervalSince1970)) vault.roothash=\(GuestPins.rootHash) vault.hashoffset=\(GuestPins.hashOffset) root=/dev/vda"
    #if VAULT_TEST_GATE
    // Test flavor only: guest smoke hooks (`vault.smoke.<name>=<value>`, read by vault-init and
    // boot.js) from CINNA_VAULT_TEST_GUEST_SMOKE, e.g. "killvaultd=touch". They grant nothing.
    if let hooks = ProcessInfo.processInfo.environment["CINNA_VAULT_TEST_GUEST_SMOKE"] {
      for w in hooks.split(separator: " ") where w.range(of: "^[a-z]+=[a-z0-9]+$", options: .regularExpression) != nil {
        boot.commandLine += " vault.smoke.\(w)"
      }
    }
    #endif
    c.bootLoader = boot
    c.platform = VZGenericPlatformConfiguration()
    let cores = ProcessInfo.processInfo.activeProcessorCount
    c.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount,
                     min(4, cores - 1, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    c.memorySize = min(UInt64(4) << 30, VZVirtualMachineConfiguration.maximumAllowedMemorySize)

    let consolePath = VaultFiles.consoleURL(vaultDir).path
    let cfd = open(consolePath, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
    guard cfd >= 0 else { throw VMError(message: "cannot open console log (errno \(errno))") }
    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: nil, fileHandleForWriting: FileHandle(fileDescriptor: cfd, closeOnDealloc: true))
    c.serialPorts = [console]
    c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

    let rootfs = URL(fileURLWithPath: doc.rootfsPath)
    guard FileManager.default.isReadableFile(atPath: rootfs.path) else {
      throw VMError(message: "guest root filesystem not found at \(doc.rootfsPath)")
    }
    let root = try VZDiskImageStorageDeviceAttachment(url: rootfs, readOnly: true)
    let data = try VZDiskImageStorageDeviceAttachment(
      url: VaultFiles.dataURL(vaultDir), readOnly: false, cachingMode: .automatic, synchronizationMode: .full)
    c.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: root), VZVirtioBlockDeviceConfiguration(attachment: data)]
    c.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    c.networkDevices = []
    c.directorySharingDevices = []
    c.consoleDevices = []
    try c.validate()
    let proxy = EgressProxy(vaultId: doc.vaultId, hosts: doc.egress)
    return VaultVM(vaultId: doc.vaultId, vm: VZVirtualMachine(configuration: c), proxy: proxy)
  }

  // MARK: boot secrets (1090)

  /// `{"approvalKey":hex,"diskKey":hex,"format":bool[,"growTo":n],"vaultId":id}\n`, built
  /// straight into a zeroable buffer; the caller zeroes `diskKey` afterwards.
  func armBootMessage(diskKey: SecretBytes, format: Bool, growTo: Int64?) {
    var b = [UInt8]()
    b += Array("{\"approvalKey\":\"".utf8)
    var ak = hexBytes(approvalKey.bytes); b += ak
    b += Array("\",\"diskKey\":\"".utf8)
    var dk = hexBytes(diskKey.bytes); b += dk
    b += Array("\",\"format\":\(format ? "true" : "false")".utf8)
    if let g = growTo { b += Array(",\"growTo\":\(g)".utf8) }
    // vaultd checks every token's vaultId against this (/run/vault/vault-id).
    b += Array(",\"vaultId\":\"\(vaultId)\"}\n".utf8)
    for i in 0..<ak.count { ak[i] = 0 }
    for i in 0..<dk.count { dk[i] = 0 }
    msgLock.lock(); bootMessage = SecretBytes(b); msgLock.unlock()
    for i in 0..<b.count { b[i] = 0 }
  }

  func dropBootMessage() {
    msgLock.lock(); bootMessage?.zero(); bootMessage = nil; msgLock.unlock()
  }

  func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                from socketDevice: VZVirtioSocketDevice) -> Bool {
    guard listener === bootListener else { return false }
    msgLock.lock()
    let msg = bootMessage
    bootMessage = nil
    msgLock.unlock()
    // One delivery per boot: a second connection (or one after a failure) gets nothing.
    guard let m = msg else { return false }
    let id = vaultId
    Thread.detachNewThread {
      let ok = writeAll(connection.fileDescriptor, m.bytes)
      m.zero()
      shutdown(connection.fileDescriptor, SHUT_WR)
      // Give the guest a moment to read before the fd goes.
      _ = waitReadable(connection.fileDescriptor, timeoutMs: 2000)
      connection.close()
      DispatchQueue.main.async {
        self.bootDelivered = ok
        if !ok { Control.emitLog("error", "vault \(id): boot message not delivered") }
      }
    }
    return true
  }

  // MARK: lifecycle

  func start(_ done: @escaping (String?) -> Void) {
    vm.start { r in
      switch r {
      case .success: done(nil)
      case .failure(let e): done("VM did not start: \(e.localizedDescription)")
      }
    }
  }

  func pause(_ done: @escaping (String?) -> Void) {
    guard vm.canPause else { done("VM cannot pause in state \(vm.state.rawValue)"); return }
    vm.pause { r in
      if case .failure(let e) = r { done(e.localizedDescription) } else { done(nil) }
    }
  }

  func resume(_ done: @escaping (String?) -> Void) {
    guard vm.canResume else { done("VM cannot resume in state \(vm.state.rawValue)"); return }
    vm.resume { r in
      if case .failure(let e) = r { done(e.localizedDescription) } else { done(nil) }
    }
  }

  /// Hard stop (D33). Idempotent; `done` always runs.
  func stop(_ done: @escaping () -> Void) {
    stopping = true  // the subscription's close during the stop is not a drop to reopen
    dropBootMessage()
    proxy.closeAll()
    if stopped || !vm.canStop {
      markStopped()
      done()
      return
    }
    vm.stop { _ in
      self.markStopped()
      done()
    }
  }

  private func markStopped() {
    if stopped { return }
    stopped = true
    approvalKey.zero()
    dropBootMessage()
    proxy.closeAll()
    if let sub = subscription { shutdown(sub.fileDescriptor, SHUT_RDWR) }
    subscription = nil
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    let was = stopped
    markStopped()
    proxy.closeAll()
    if !was { onStop?(nil) }
  }

  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
    let was = stopped
    markStopped()
    proxy.closeAll()
    if !was { onStop?("VM stopped with an error: \(error.localizedDescription)") }
  }

  // MARK: guest ports

  /// Opens a host → guest vsock connection (main queue).
  func connect(port: UInt32, _ done: @escaping (VZVirtioSocketConnection?, String?) -> Void) {
    socket.connect(toPort: port) { r in
      switch r {
      case .success(let c): done(c, nil)
      case .failure(let e): done(nil, e.localizedDescription)
      }
    }
  }

  /// Polls vaultd's `hello` on 5000 until it answers or the deadline passes.
  func waitReady(deadline: Date, _ done: @escaping (String?) -> Void) {
    if stopped { done("VM stopped while booting"); return }
    if Date() > deadline { done("guest did not answer within the boot timeout"); return }
    let retry = {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitReady(deadline: deadline, done) }
    }
    guard bootDelivered else { retry(); return }
    connect(port: PORT_VAULTD) { conn, _ in
      guard let c = conn else { retry(); return }
      Thread.detachNewThread {
        let fd = c.fileDescriptor
        let req = "{\"type\":\"control\"}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{}}\n"
        var ok = false
        if writeAll(fd, Array(req.utf8)) {
          let until = Date().addingTimeInterval(5)
          while Date() < until, let line = readSocketLine(fd, timeoutMs: 5000) {
            if let o = parseJSONObject(line), (o["id"] as? NSNumber)?.intValue == 1 {
              ok = o["result"] != nil
              break
            }
          }
        }
        c.close()
        DispatchQueue.main.async { ok ? done(nil) : retry() }
      }
    }
  }

  /// One request line on 5001 and its ack. `line` is zeroed after the write.
  func helperControl(_ line: SecretBytes, timeoutMs: Int, _ done: @escaping (String?) -> Void) {
    connect(port: PORT_HELPER_CONTROL) { conn, err in
      guard let c = conn else { line.zero(); done("guest control port: \(err ?? "unreachable")"); return }
      Thread.detachNewThread {
        let fd = c.fileDescriptor
        let wrote = writeAll(fd, line.bytes)
        line.zero()
        var result: String? = wrote ? nil : "guest control write failed"
        if wrote {
          if let reply = readSocketLine(fd, timeoutMs: timeoutMs), let o = parseJSONObject(reply) {
            let ok = (o["ok"] as? Bool) == true || (o["result"] != nil && o["error"] == nil)
            if !ok { result = "guest refused: \(sanitizeForPrompt(reply, max: 200))" }
          } else {
            result = "guest did not acknowledge"
          }
        }
        c.close()
        DispatchQueue.main.async { done(result) }
      }
    }
  }

  // MARK: guest events (D37)

  /// Opens the long-lived 5001 subscription unless one is open. vaultd pushes
  /// one JSON object per line; `{"event":"exec-end","proxyCred":"…"}` revokes
  /// that install credential.
  ///
  /// Fail closed: whenever the subscription drops (vaultd restarted, the
  /// guest closed it), every live install credential of this vault is revoked,
  /// since an exec-end could be lost while nobody listens. While the VM runs it
  /// is reopened with backoff (0.25 s doubling to 5 s); a reopen after a drop
  /// revokes again on its ack, for credentials minted during the gap. A paused
  /// (locked) or stopped VM is not retried: the next unlock calls this again.
  /// A guest that answers `{"ok":false}` has no subscribe op: logged once, not
  /// retried for this VM; its credentials then end at expiry or lock.
  func subscribeIfNeeded() {
    subscribe(attempt: 0, afterDrop: false)
  }

  private func subscribe(attempt: Int, afterDrop: Bool) {
    guard subscription == nil, !subscribing, !stopped, !stopping, !subscribeUnsupported else { return }
    subscribing = true
    let id = vaultId
    connect(port: PORT_HELPER_CONTROL) { conn, err in
      self.subscribing = false
      guard let c = conn else {
        if attempt == 0 { logStderr("vault \(id): event subscription not opened: \(err ?? "unreachable")") }
        self.resubscribeLater(attempt: attempt + 1, afterDrop: afterDrop)
        return
      }
      if self.stopped || self.subscription != nil { c.close(); return }
      self.subscription = c
      let proxy = self.proxy
      Thread.detachNewThread {
        let fd = c.fileDescriptor
        var events = 0
        var acked = false
        var refused = false
        if writeAll(fd, Array("{\"op\":\"subscribe\"}\n".utf8)) {
          var pending = [UInt8]()
          var buf = [UInt8](repeating: 0, count: 4096)
          reading: while true {
            let n = read(fd, &buf, buf.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            pending += buf[0..<n]
            while let nl = pending.firstIndex(of: 10) {
              let line = String(decoding: pending[..<nl], as: UTF8.self)
              pending.removeSubrange(...nl)
              guard let o = parseJSONObject(line) else { continue }
              if !acked && (o["ok"] as? Bool) == false { refused = true; break reading }
              if !acked && ((o["ok"] as? Bool) == true || o["event"] != nil) {
                acked = true
                if afterDrop { proxy.revokeAll() }
                DispatchQueue.main.async { logStderr("vault \(id): event subscription open") }
              }
              if o["event"] as? String == "exec-end", let cred = o["proxyCred"] as? String {
                events += 1
                proxy.revoke(cred)
              }
            }
            if pending.count > 64 * 1024 { break reading }
          }
        }
        c.close()
        // Fail closed (D37): nobody hears exec-end now.
        proxy.revokeAll()
        DispatchQueue.main.async {
          if self.subscription === c { self.subscription = nil }
          if self.stopped || self.stopping { return }
          if refused {
            self.subscribeUnsupported = true
            logStderr("vault \(id): the guest refused the event subscription (no subscribe support); install credentials end at expiry or lock")
            return
          }
          // One line per drop, not one per failed retry.
          if acked || attempt == 0 {
            logStderr("vault \(id): event subscription closed after \(events) event(s); install credentials revoked, reopening")
          }
          // An acked subscription that drops starts the backoff over.
          self.resubscribeLater(attempt: acked ? 0 : attempt + 1, afterDrop: true)
        }
      }
    }
  }

  /// Retries the subscription while the VM runs (main queue).
  private func resubscribeLater(attempt: Int, afterDrop: Bool) {
    let delay = min(5.0, 0.25 * pow(2.0, Double(min(attempt, 5))))
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      guard !self.stopped, !self.stopping, self.vm.state == .running else { return }
      self.subscribe(attempt: attempt, afterDrop: afterDrop)
    }
  }

  func suspendGuest(_ done: @escaping (String?) -> Void) {
    helperControl(SecretBytes(Array("{\"op\":\"suspend\"}\n".utf8)), timeoutMs: 10_000, done)
  }

  /// `{"op":"resume","key":"<hex>"}`; zeroes `diskKey` once written.
  func resumeGuest(diskKey: SecretBytes, _ done: @escaping (String?) -> Void) {
    var b = Array("{\"key\":\"".utf8)
    var k = hexBytes(diskKey.bytes); b += k
    b += Array("\",\"op\":\"resume\"}\n".utf8)
    for i in 0..<k.count { k[i] = 0 }
    diskKey.zero()
    let line = SecretBytes(b)
    for i in 0..<b.count { b[i] = 0 }
    helperControl(line, timeoutMs: 30_000, done)
  }
}
