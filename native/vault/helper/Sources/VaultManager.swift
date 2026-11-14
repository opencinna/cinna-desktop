// Vault registry, lifecycle state machine and the control methods (spec §1).
// Main queue only, except the prompt queue, which runs one presence prompt
// (unlock unwrap or gated approval) at a time.
//
// States: stopped (no VM) → booting → unlocked ⇄ locking → locked (paused,
// no key anywhere) → stopped after PAUSED_STOP_MS. `error` = the last boot or
// run failed; `tampered` = vault.json failed verification.
//
// The helper learns where a vault lives only from vault.list or vault.create
// in this process (methods after that take a vaultId alone), and the first
// absolute SecureAgents dir it sees is the only one it accepts afterwards (M5).
//
// Lock wins (D40): every lock bumps the entry's lockGeneration and every
// lock-all bumps the global one. An unlock records both when it starts; if
// either moved by the time the prompt, the resume or the boot finishes, the
// vault is locked again (a boot is stopped cold) and the unlock fails. Unlock is
// refused while the console session's screen is locked. Holds die on lock and
// after HOLD_MAX_MS each.
import CoreGraphics
import Foundation

final class VaultEntry {
  let vaultId: String
  var vaultDir: URL
  var doc: VaultDoc?
  var tamperedWhy: String?
  var raw: [String: Any]?
  var vm: VaultVM?
  var state = "stopped"
  var lastError: String?
  /// holdId → when it stops counting (D40: at most HOLD_MAX_MS).
  var holds: [String: Int64] = [:]
  var holdTimer: DispatchWorkItem?
  var until: Int64?
  var lockGeneration = 0
  var windowTimer: DispatchWorkItem?
  var pausedTimer: DispatchWorkItem?
  var unlocking = false
  var stopRequested = false
  var unlockWaiters: [(HelperError?) -> Void] = []

  init(vaultId: String, vaultDir: URL) {
    self.vaultId = vaultId
    self.vaultDir = vaultDir
  }

  var agentName: String {
    doc?.agentName ?? "(tampered vault \(vaultId))"
  }
}

final class VaultManager {
  static let shared = VaultManager()
  private var vaults: [String: VaultEntry] = [:]
  private let promptQueue = DispatchQueue(label: "vault.prompt")
  /// D40: bumped by every lock-all.
  private var lockGeneration = 0
  /// M5: the SecureAgents dir, fixed by the first vault.list / vault.create.
  private var pinnedDir: String?

  /// The console session's screen is locked (or, in the test flavor, says so).
  static func screenIsLocked() -> Bool {
    #if VAULT_TEST_GATE
    switch ProcessInfo.processInfo.environment["CINNA_VAULT_TEST_SCREEN_LOCKED"] {
    case "1": return true
    case "0": return false // unattended lanes on a Mac whose screen is locked
    default: break
    }
    #endif
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true
  }

  // MARK: dispatch

  func dispatch(method: String, params: [String: Any], reply: @escaping Reply) {
    do {
      switch method {
      case "hello":
        let proto = try params.int64("protocol")
        guard proto == Int64(HELPER_PROTOCOL) else {
          throw HelperError(code: "invalid", message: "helper speaks protocol \(HELPER_PROTOCOL), not \(proto)")
        }
        var r: [String: Any] = [
          "protocol": HELPER_PROTOCOL, "flavor": FLAVOR.rawValue, "helperVersion": helperVersion,
          "guest": ["version": GuestPins.version, "rootHash": GuestPins.rootHash],
        ]
        #if VAULT_TEST_GATE
        // The parent-check verdict, reported (not enforced) for the probes.
        r["parent"] = ["verified": parentVerdict.verified, "trusted": parentVerdict.trusted, "detail": parentVerdict.detail]
        #endif
        reply(r, nil)
      case "availability":
        reply(availability(), nil)
      case "vault.list":
        reply(["vaults": try list(dir: try params.str("dir"))], nil)
      case "vault.create":
        reply(["vault": try create(params)], nil)
      case "vault.unlock":
        let e = try entry(params)
        let purpose = (params["purpose"] as? String) ?? ""
        unlock(e, purpose: purpose) { err in
          if let err = err { reply(nil, err) } else { reply(["state": e.state], nil) }
        }
      case "vault.lock":
        let e = try entry(params)
        lock(e, why: "requested") { reply(["state": e.state], nil) }
      case "vault.hold":
        let e = try entry(params)
        let holdId = try params.str("holdId")
        guard !holdId.isEmpty, holdId.count <= 200 else { throw HelperError.invalid("bad holdId") }
        guard e.state == "unlocked" else { throw HelperError(code: "locked", message: "vault is \(e.state)") }
        guard e.holds.count < 64 || e.holds[holdId] != nil else { throw HelperError.invalid("too many holds") }
        e.holds[holdId] = nowMs() + Int64(HOLD_MAX_MS)
        restartWindow(e)
        reply([String: Any](), nil)
      case "vault.release":
        let e = try entry(params)
        let holdId = try params.str("holdId")
        if e.holds.removeValue(forKey: holdId) != nil && e.holds.isEmpty && e.state == "unlocked" { restartWindow(e) }
        reply([String: Any](), nil)
      case "vault.status":
        let e = try entry(params)
        if e.vm == nil { reload(e) }
        reply(summary(e), nil)
      case "vault.approve":
        let e = try entry(params)
        approve(e, action: try params.str("action"), detail: try params.str("detail"), reply: reply)
      case "vault.setEgress":
        try setEgress(try entry(params), hosts: try params.hosts("policy"), token: try params.str("token"))
        reply([String: Any](), nil)
      case "vault.resize":
        try resize(try entry(params), size: try params.int64("sizeBytes"), token: try params.str("token"))
        reply([String: Any](), nil)
      case "vault.destroy":
        let e = try entry(params)
        try destroy(e, token: try params.str("token")) { reply([String: Any](), nil) }
      case "channel.open":
        openChannel(try entry(params), reply: reply)
      default:
        throw HelperError.invalid("unknown method \(sanitizeForPrompt(method, max: 60))")
      }
    } catch let e as HelperError {
      reply(nil, e)
    } catch let e as ApprovalError {
      reply(nil, HelperError(code: e.code, message: e.message))
    } catch let e as CustodyError {
      reply(nil, HelperError(code: e.code, message: e.message))
    } catch {
      reply(nil, HelperError(code: "internal", message: "\(error)"))
    }
  }

  private func entry(_ params: [String: Any]) throws -> VaultEntry {
    let id = try params.str("vaultId")
    guard isValidVaultId(id) else { throw HelperError.invalid("bad vaultId") }
    guard let e = vaults[id] else { throw HelperError(code: "not_found", message: "unknown vault (list or create it first)") }
    return e
  }

  // MARK: state

  private func setState(_ e: VaultEntry, _ s: String, error: String? = nil) {
    e.state = s
    e.lastError = error
    if s != "unlocked" { e.until = nil }
    var ev: [String: Any] = ["event": "vault.state", "vaultId": e.vaultId, "state": s]
    if s == "unlocked" { ev["until"] = e.until.map { NSNumber(value: $0) } ?? NSNull() }
    if let err = error { ev["error"] = err }
    Control.emit(ev)
  }

  /// D13: 60 s after the last hold release or gated action; open-ended while
  /// held, each hold for at most HOLD_MAX_MS (D40).
  private func restartWindow(_ e: VaultEntry) {
    e.windowTimer?.cancel()
    e.windowTimer = nil
    e.holdTimer?.cancel()
    e.holdTimer = nil
    guard e.state == "unlocked" else { return }
    let now = nowMs()
    let expired = e.holds.filter { $0.value <= now }.map { $0.key }
    if !expired.isEmpty {
      for k in expired { e.holds[k] = nil }
      logStderr("vault \(e.vaultId): \(expired.count) hold(s) dropped after \(HOLD_MAX_MS / 60_000) min")
    }
    if let next = e.holds.values.min() {
      let h = DispatchWorkItem { [weak self, weak e] in
        guard let self = self, let e = e, e.state == "unlocked" else { return }
        self.restartWindow(e)
      }
      e.holdTimer = h
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, next - now)) + 10), execute: h)
    }
    if e.holds.isEmpty {
      e.until = nowMs() + Int64(UNLOCK_WINDOW_MS)
      let w = DispatchWorkItem { [weak self, weak e] in
        guard let self = self, let e = e, e.state == "unlocked", e.holds.isEmpty else { return }
        self.lock(e, why: "unlock window ended") {}
      }
      e.windowTimer = w
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(UNLOCK_WINDOW_MS), execute: w)
    } else {
      e.until = nil
    }
    setState(e, "unlocked")
  }

  private func reload(_ e: VaultEntry) {
    switch VaultFiles.load(e.vaultDir) {
    case .ok(let doc):
      e.doc = doc; e.tamperedWhy = nil; e.raw = nil
      if e.state == "tampered" { e.state = "stopped" }
    case .tampered(let why, let raw):
      e.doc = nil; e.tamperedWhy = why; e.raw = raw
      if e.vm == nil { e.state = "tampered" }
    case .missing:
      e.doc = nil; e.tamperedWhy = "vault.json missing"; e.raw = nil
      if e.vm == nil { e.state = "tampered" }
    }
  }

  func summary(_ e: VaultEntry) -> [String: Any] {
    let r = e.raw ?? [:]
    var o: [String: Any] = [
      "vaultId": e.vaultId,
      "agentId": e.doc?.agentId ?? (r["agentId"] as? String ?? ""),
      "agentName": e.doc?.agentName ?? (r["agentName"] as? String ?? ""),
      "engine": e.doc?.engine ?? (r["engine"] as? String ?? "claude"),
      "state": e.state,
      "sizeBytes": e.doc?.sizeBytes ?? ((r["sizeBytes"] as? NSNumber)?.int64Value ?? 0),
      "egress": ["hosts": e.doc?.egress ?? []],
      "createdAt": e.doc?.createdAt ?? ((r["createdAt"] as? NSNumber)?.int64Value ?? 0),
      "imageVersion": e.doc?.imageVersion ?? (r["imageVersion"] as? String ?? ""),
    ]
    if e.state == "unlocked" { o["until"] = e.until.map { NSNumber(value: $0) } ?? NSNull() }
    return o
  }

  // MARK: list / create

  /// M5: the first absolute dir is pinned; any other one is refused from then on.
  private func pin(dir: String) throws -> URL {
    guard dir.hasPrefix("/") else { throw HelperError.invalid("dir must be absolute") }
    let root = URL(fileURLWithPath: dir, isDirectory: true).standardizedFileURL
    if let p = pinnedDir {
      guard p == root.path else { throw HelperError.invalid("this helper already serves another SecureAgents folder") }
    } else {
      pinnedDir = root.path
      logStderr("SecureAgents folder pinned for this process")
    }
    return root
  }

  private func list(dir: String) throws -> [[String: Any]] {
    let root = try pin(dir: dir)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
    var out: [VaultEntry] = []
    for name in names.sorted() where isValidVaultId(name) {
      let vdir = root.appendingPathComponent(name, isDirectory: true)
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: vdir.path, isDirectory: &isDir), isDir.boolValue,
            FileManager.default.fileExists(atPath: VaultFiles.jsonURL(vdir).path) else { continue }
      let e: VaultEntry
      if let existing = vaults[name] {
        e = existing
        if e.vm == nil { e.vaultDir = vdir }
      } else {
        e = VaultEntry(vaultId: name, vaultDir: vdir)
        vaults[name] = e
      }
      if e.vm == nil { reload(e) }
      out.append(e)
    }
    return out.map(summary)
  }

  private func create(_ p: [String: Any]) throws -> [String: Any] {
    guard isAvailable() else { throw HelperError(code: "unavailable", message: "\(availability()["reason"] ?? "unavailable")") }
    let dir = try p.str("dir"), vaultId = try p.str("vaultId"), agentId = try p.str("agentId")
    let agentName = try p.str("agentName"), engine = try p.str("engine"), rootfsPath = try p.str("rootfsPath")
    let size = try p.int64("sizeBytes"), hosts = try p.hosts("egress")
    guard dir.hasPrefix("/"), rootfsPath.hasPrefix("/") else { throw HelperError.invalid("dir and rootfsPath must be absolute") }
    guard isValidVaultId(vaultId) else { throw HelperError.invalid("bad vaultId") }
    guard !agentId.isEmpty, agentId.count <= 200 else { throw HelperError.invalid("bad agentId") }
    guard isValidAgentName(agentName) else {
      throw HelperError.invalid("agentName may hold only letters, digits, spaces and . _ - ' ( )")
    }
    guard VAULT_ENGINES.contains(engine) else { throw HelperError.invalid("unknown engine") }
    guard size >= MIN_VAULT_SIZE, size <= MAX_VAULT_SIZE else { throw HelperError.invalid("sizeBytes out of range") }
    if vaults[vaultId]?.vm != nil { throw HelperError(code: "busy", message: "vault is running") }

    let root = try pin(dir: dir)
    let vdir = root.appendingPathComponent(vaultId, isDirectory: true)
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    do {
      try fm.createDirectory(at: vdir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    } catch {
      throw HelperError(code: "busy", message: "a vault with this id already exists")
    }
    do {
      let dataPath = VaultFiles.dataURL(vdir).path
      guard fm.createFile(atPath: dataPath, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw HelperError(code: "internal", message: "cannot create data.img")
      }
      let fh = try FileHandle(forWritingTo: VaultFiles.dataURL(vdir))
      try fh.truncate(atOffset: UInt64(size))  // sparse
      try fh.close()
      let wrapped = try KeyCustody.newDiskKey(vaultDir: vdir)
      let doc = VaultDoc(vaultId: vaultId, agentId: agentId, agentName: agentName, engine: engine, sizeBytes: size,
                         egress: hosts, createdAt: nowMs(), imageVersion: GuestPins.version, wrappedKey: wrapped,
                         pendingGrowTo: nil, formatted: false, rootfsPath: rootfsPath)
      try VaultFiles.save(doc, vdir)
      let e = VaultEntry(vaultId: vaultId, vaultDir: vdir)
      e.doc = doc
      vaults[vaultId] = e
      return summary(e)
    } catch {
      KeyCustody.forget(vaultId: vaultId, vaultDir: vdir)
      try? fm.removeItem(at: vdir)
      throw error
    }
  }

  // MARK: unlock

  private func unlock(_ e: VaultEntry, purpose: String, _ done: @escaping (HelperError?) -> Void) {
    guard isAvailable() else {
      done(HelperError(code: "unavailable", message: "\(availability()["reason"] ?? "unavailable")")); return
    }
    if e.vm == nil { reload(e) }
    guard let doc = e.doc else { done(HelperError(code: "tampered", message: e.tamperedWhy ?? "tampered")); return }
    if e.state == "unlocked" { done(nil); return }
    if e.state == "locking" { done(HelperError(code: "busy", message: "vault is locking")); return }
    if VaultManager.screenIsLocked() { done(HelperError(code: "denied", message: "the Mac's screen is locked")); return }
    e.unlockWaiters.append(done)
    if e.unlocking { return }
    e.unlocking = true
    let reason = Approvals.unlockReason(agentName: doc.agentName)
    logStderr("unlock \(e.vaultId) requested (\(sanitizeForPrompt(purpose, max: 80)))")
    let dir = e.vaultDir, wrapped = doc.wrappedKey
    let gen = generation(e)
    promptQueue.async {
      #if VAULT_TEST_GATE
      // Lets the smoke land a screen-lock stand-in while the "prompt" is up.
      if let ms = testEnvMs("CINNA_VAULT_TEST_UNLOCK_DELAY_MS", min: 1) { usleep(useconds_t(ms) * 1000) }
      #endif
      do {
        let key = try KeyCustody.unwrap(vaultDir: dir, wrapped: wrapped, reason: reason)
        DispatchQueue.main.async {
          if let why = self.lockedSince(e, gen) {
            key.zero()
            self.finishUnlock(e, HelperError(code: "locked", message: why))
            return
          }
          self.continueUnlock(e, key, gen)
        }
      } catch let c as CustodyError {
        DispatchQueue.main.async { self.finishUnlock(e, HelperError(code: c.code, message: c.message)) }
      } catch {
        DispatchQueue.main.async { self.finishUnlock(e, HelperError(code: "internal", message: "\(error)")) }
      }
    }
  }

  /// (global, entry) lock generations; see the header.
  private func generation(_ e: VaultEntry) -> (Int, Int) { (lockGeneration, e.lockGeneration) }

  /// nil = no lock happened since `gen` was taken (and the screen is unlocked).
  private func lockedSince(_ e: VaultEntry, _ gen: (Int, Int)) -> String? {
    if generation(e) != gen { return "the vault was locked while it was unlocking" }
    if VaultManager.screenIsLocked() { return "the Mac's screen is locked" }
    return nil
  }

  private func finishUnlock(_ e: VaultEntry, _ err: HelperError?) {
    e.unlocking = false
    let waiters = e.unlockWaiters
    e.unlockWaiters = []
    waiters.forEach { $0(err) }
  }

  private func continueUnlock(_ e: VaultEntry, _ key: SecretBytes, _ gen: (Int, Int)) {
    if let vm = e.vm, e.state == "locked" {
      // Resume (D22): VM resumes, then luksResume with the key over 5001.
      e.pausedTimer?.cancel(); e.pausedTimer = nil
      vm.resume { err in
        if let err = err {
          key.zero()
          self.coldStop(e, error: "resume failed: \(err)") { self.finishUnlock(e, HelperError(code: "internal", message: err)) }
          return
        }
        vm.resumeGuest(diskKey: key) { err in
          guard e.vm === vm else { self.finishUnlock(e, HelperError(code: "internal", message: "vault stopped while resuming")); return }
          if let err = err {
            self.coldStop(e, error: err) { self.finishUnlock(e, HelperError(code: "internal", message: err)) }
            return
          }
          e.state = "unlocked"
          // D40: a lock that came in while resuming wins: lock again at once.
          if let why = self.lockedSince(e, gen) {
            self.lock(e, why: why) { self.finishUnlock(e, HelperError(code: "locked", message: why)) }
            return
          }
          self.restartWindow(e)
          vm.subscribeIfNeeded()
          self.finishUnlock(e, nil)
        }
      }
      return
    }
    if let vm = e.vm {  // a VM in a state we cannot resume from: replace it
      key.zero()
      coldStop(e, error: nil) { self.finishUnlock(e, HelperError(code: "busy", message: "vault was \(e.state); try again")) }
      _ = vm
      return
    }
    coldBoot(e, key, gen)
  }

  private func coldBoot(_ e: VaultEntry, _ key: SecretBytes, _ gen: (Int, Int)) {
    guard var doc = e.doc, let assets = guestAssets() else {
      key.zero(); finishUnlock(e, HelperError(code: "unavailable", message: "image-missing")); return
    }
    let vm: VaultVM
    do {
      try prepareDisk(&doc, e.vaultDir)
      vm = try VaultVM.make(doc: doc, vaultDir: e.vaultDir, assets: assets)
    } catch {
      key.zero()
      let m = (error as? VMError)?.message ?? (error as? HelperError)?.message ?? "\(error)"
      setState(e, "error", error: m)
      finishUnlock(e, HelperError(code: "internal", message: m))
      return
    }
    let format = !doc.formatted
    vm.armBootMessage(diskKey: key, format: format, growTo: doc.pendingGrowTo)
    key.zero()
    vm.onStop = { [weak self, weak e] err in
      guard let self = self, let e = e, e.vm === vm else { return }
      self.afterStop(e, error: err)
    }
    e.vm = vm
    e.holds.removeAll()
    setState(e, "booting")
    vm.start { err in
      if let err = err {
        vm.dropBootMessage()
        if e.vm === vm { e.vm = nil }
        self.setState(e, "error", error: err)
        self.finishUnlock(e, HelperError(code: "internal", message: err))
        return
      }
      let deadline = Date().addingTimeInterval(format ? 300 : 90)
      vm.waitReady(deadline: deadline) { err in
        vm.dropBootMessage()
        guard e.vm === vm else { self.finishUnlock(e, HelperError(code: "internal", message: err ?? "vault stopped while booting")); return }
        if let err = err {
          self.coldStop(e, error: err) { self.finishUnlock(e, HelperError(code: "internal", message: err)) }
          return
        }
        if !doc.formatted || doc.pendingGrowTo != nil {
          var updated = doc
          updated.formatted = true
          if let g = updated.pendingGrowTo { updated.sizeBytes = g; updated.pendingGrowTo = nil }
          do {
            try VaultFiles.save(updated, e.vaultDir)
            e.doc = updated
          } catch {
            // D38: a disk not recorded as formatted would be offered for
            // formatting again; stop now rather than run on it.
            let m = "the vault's disk is ready but vault.json could not record it (\(error)); the vault was stopped"
            Control.emitLog("error", "vault \(e.vaultId): \(m)")
            self.coldStop(e, error: m) { self.finishUnlock(e, HelperError(code: "internal", message: m)) }
            return
          }
        }
        // D40: a lock that came in while booting wins (lock() already stops a
        // booting vault; this covers a lock-all that found it still stopped).
        if let why = self.lockedSince(e, gen) {
          self.coldStop(e, error: nil, note: why) { self.finishUnlock(e, HelperError(code: "locked", message: why)) }
          return
        }
        e.state = "unlocked"
        self.restartWindow(e)
        vm.subscribeIfNeeded()
        self.finishUnlock(e, nil)
      }
    }
  }

  /// Applies a pending grow to data.img (sparse) before boot.
  private func prepareDisk(_ doc: inout VaultDoc, _ dir: URL) throws {
    let url = VaultFiles.dataURL(dir)
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = (attrs[.size] as? NSNumber)?.int64Value else {
      throw HelperError(code: "internal", message: "data.img is missing")
    }
    let target = max(doc.sizeBytes, doc.pendingGrowTo ?? 0)
    if size < target {
      let fh = try FileHandle(forWritingTo: url)
      try fh.truncate(atOffset: UInt64(target))
      try fh.close()
    }
  }

  // MARK: lock / stop

  func lock(_ e: VaultEntry, why: String, _ done: @escaping () -> Void) {
    e.lockGeneration += 1  // D40: an unlock in flight loses
    e.windowTimer?.cancel(); e.windowTimer = nil
    e.holdTimer?.cancel(); e.holdTimer = nil
    e.holds.removeAll()
    guard let vm = e.vm else { done(); return }
    vm.proxy.revokeAll()
    switch e.state {
    case "unlocked":
      logStderr("locking \(e.vaultId): \(why)")
      setState(e, "locking")
      vm.suspendGuest { err in
        guard e.vm === vm else { done(); return }
        if let err = err {
          // Without the guest's word that the key is gone, only a cold stop is safe.
          self.coldStop(e, error: nil, note: "suspend failed (\(err)); stopped instead") { done() }
          return
        }
        vm.pause { err in
          guard e.vm === vm else { done(); return }
          if let err = err {
            self.coldStop(e, error: nil, note: "pause failed (\(err)); stopped instead") { done() }
            return
          }
          self.setState(e, "locked")
          let t = DispatchWorkItem { [weak self, weak e] in
            guard let self = self, let e = e, e.vm === vm, e.state == "locked" else { return }
            self.coldStop(e, error: nil, note: "locked for \(PAUSED_STOP_MS / 60_000) min") {}
          }
          e.pausedTimer = t
          DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(PAUSED_STOP_MS), execute: t)
          done()
        }
      }
    case "booting":
      coldStop(e, error: nil, note: "locked while booting") { done() }
    default:
      done()
    }
  }

  func coldStop(_ e: VaultEntry, error: String?, note: String? = nil, _ done: @escaping () -> Void) {
    if let n = note { logStderr("stopping \(e.vaultId): \(n)") }
    guard let vm = e.vm else { done(); return }
    e.stopRequested = true
    vm.stop {
      if e.vm === vm { self.afterStop(e, error: error) }
      done()
    }
  }

  private func afterStop(_ e: VaultEntry, error: String?) {
    // A guest that powers itself off while booting failed (vault-init: VAULT FAILED …).
    let error = error ?? (e.state == "booting" && e.vm?.stopped == true && !e.stopRequested
      ? "the vault stopped while booting; see console.log in the vault folder" : nil)
    e.stopRequested = false
    e.vm?.proxy.closeAll()
    e.vm = nil
    e.windowTimer?.cancel(); e.windowTimer = nil
    e.holdTimer?.cancel(); e.holdTimer = nil
    e.pausedTimer?.cancel(); e.pausedTimer = nil
    e.holds.removeAll()
    Channels.resetAll(vaultId: e.vaultId, reason: "vault stopped")
    setState(e, error == nil ? "stopped" : "error", error: error)
  }

  /// D21: screen lock, sleep, fast user switch, logout.
  func lockAll(why: String) {
    lockGeneration += 1  // D40: every unlock in flight loses, whatever its state
    for e in vaults.values where e.state == "unlocked" || e.state == "booting" {
      lock(e, why: why) {}
    }
  }

  /// Stdin EOF: stop everything, then exit.
  func stopAllAndExit(code: Int32) {
    let running = vaults.values.filter { $0.vm != nil }
    let group = DispatchGroup()
    for e in running {
      group.enter()
      coldStop(e, error: nil, note: "Cinna went away") { group.leave() }
    }
    let finish = {
      FrameWriter.shared.flush()
      exit(code)
    }
    group.notify(queue: .main, execute: finish)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: finish)
  }

  // MARK: approvals

  private func approve(_ e: VaultEntry, action: String, detail: String, reply: @escaping Reply) {
    guard GATED_ACTIONS.contains(action) else { reply(nil, HelperError.invalid("unknown action")); return }
    if e.vm == nil { reload(e) }
    if e.doc == nil && action != "destroy" {
      reply(nil, HelperError(code: "tampered", message: e.tamperedWhy ?? "tampered")); return
    }
    let reason: String
    do {
      reason = try Approvals.reason(action: action, detail: detail, agentName: e.agentName, sizeBytes: e.doc?.sizeBytes ?? 0)
    } catch let a as ApprovalError {
      reply(nil, HelperError(code: a.code, message: a.message)); return
    } catch {
      reply(nil, HelperError(code: "internal", message: "\(error)")); return
    }
    if action == "move-in" || action == "install" {
      logStderr("approve \(action) for \(e.vaultId): \(sanitizeForPrompt(detail, max: 120))")  // L1: logged, not shown
    }
    let guestVerified = GUEST_VERIFIED_ACTIONS.contains(action)
    if guestVerified && (e.state != "unlocked" || e.vm == nil) {
      reply(nil, HelperError(code: "locked", message: "unlock the vault first")); return
    }
    promptQueue.async {
      let sem = DispatchSemaphore(value: 0)
      var result: ApprovalError?
      Presence.require(reason: reason) { result = $0; sem.signal() }
      sem.wait()
      DispatchQueue.main.async {
        if let r = result { reply(nil, HelperError(code: r.code, message: r.message)); return }
        let token: String
        if guestVerified {
          guard let vm = e.vm, e.state == "unlocked" else {
            reply(nil, HelperError(code: "locked", message: "the vault locked during the prompt")); return
          }
          if action == "move-in" || action == "install" {
            // D37: the install hosts open only for the exec holding this credential.
            let exp = nowMs() + (APPROVAL_TTL_MS[action] ?? 600_000)
            let cred = vm.proxy.mintCred(until: exp)
            token = Approvals.mint(vaultId: e.vaultId, action: action, detail: detail, key: vm.approvalKey,
                                   exp: exp, proxyCred: cred)
          } else {
            token = Approvals.mint(vaultId: e.vaultId, action: action, detail: detail, key: vm.approvalKey)
          }
        } else {
          token = Approvals.mint(vaultId: e.vaultId, action: action, detail: detail, key: Approvals.helperKey)
        }
        if e.state == "unlocked" { self.restartWindow(e) }  // a gated action restarts the window (D13)
        reply(["token": token], nil)
      }
    }
  }

  private func setEgress(_ e: VaultEntry, hosts: [String], token: String) throws {
    if e.vm == nil { reload(e) }
    guard var doc = e.doc else { throw HelperError(code: "tampered", message: e.tamperedWhy ?? "tampered") }
    try Approvals.verifyHelperToken(token, vaultId: e.vaultId, action: "egress", detail: Approvals.egressDetail(hosts))
    doc.egress = hosts
    do {
      try VaultFiles.save(doc, e.vaultDir)
    } catch {
      resyncAfterFailedSave(e)
      throw error
    }
    e.doc = doc
    e.vm?.proxy.setHosts(hosts)
  }

  /// M1: a save can fail after vault.json was written (the current digest
  /// slot not updated). Re-read the file so memory and the proxy follow what is
  /// on disk; if it no longer verifies, a running vault keeps its last good doc.
  private func resyncAfterFailedSave(_ e: VaultEntry) {
    if case .ok(let disk) = VaultFiles.load(e.vaultDir) {
      e.doc = disk
      e.vm?.proxy.setHosts(disk.egress)
    } else if e.vm == nil {
      reload(e)
    }
  }

  private func resize(_ e: VaultEntry, size: Int64, token: String) throws {
    if e.vm == nil { reload(e) }
    guard var doc = e.doc else { throw HelperError(code: "tampered", message: e.tamperedWhy ?? "tampered") }
    guard size > doc.sizeBytes, size <= MAX_VAULT_SIZE else { throw HelperError.invalid("a vault disk can only grow, up to 2 TB") }
    try Approvals.verifyHelperToken(token, vaultId: e.vaultId, action: "resize", detail: Approvals.resizeDetail(size))
    doc.pendingGrowTo = size
    do {
      try VaultFiles.save(doc, e.vaultDir)
    } catch {
      resyncAfterFailedSave(e)
      throw error
    }
    e.doc = doc
  }

  private func destroy(_ e: VaultEntry, token: String, _ done: @escaping () -> Void) throws {
    try Approvals.verifyHelperToken(token, vaultId: e.vaultId, action: "destroy", detail: "destroy")
    coldStop(e, error: nil, note: "destroyed") {
      let dir = e.vaultDir
      KeyCustody.forget(vaultId: e.vaultId, vaultDir: dir)
      if dir.lastPathComponent == e.vaultId { try? FileManager.default.removeItem(at: dir) }
      self.vaults[e.vaultId] = nil
      if e.state != "stopped" { self.setState(e, "stopped") }
      done()
    }
  }

  // MARK: channels

  private func openChannel(_ e: VaultEntry, reply: @escaping Reply) {
    guard let vm = e.vm, e.state == "unlocked" else {
      reply(nil, HelperError(code: "locked", message: "vault is \(e.state)")); return
    }
    vm.connect(port: PORT_VAULTD) { conn, err in
      guard let c = conn else { reply(nil, HelperError(code: "internal", message: "vaultd unreachable: \(err ?? "")")); return }
      guard e.vm === vm else { c.close(); reply(nil, HelperError(code: "locked", message: "vault stopped")); return }
      let id = Channels.add(vaultId: e.vaultId, conn: c)
      reply(["channel": id], nil)
      Channels.start(id)
    }
  }
}
