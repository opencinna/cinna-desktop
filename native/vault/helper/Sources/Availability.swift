// availability (spec §1): can this Mac run a vault with this helper?
import Foundation
import Virtualization

struct GuestAssets {
  let kernel: URL
  let initrd: URL
}

/// Image and initrd.img inside Contents/Resources/guest, and a root hash compiled in.
func guestAssets() -> GuestAssets? {
  guard !GuestPins.rootHash.isEmpty, let res = Bundle.main.resourceURL else { return nil }
  let dir = res.appendingPathComponent("guest", isDirectory: true)
  let kernel = dir.appendingPathComponent("Image"), initrd = dir.appendingPathComponent("initrd.img")
  let fm = FileManager.default
  guard fm.isReadableFile(atPath: kernel.path), fm.isReadableFile(atPath: initrd.path) else { return nil }
  return GuestAssets(kernel: kernel, initrd: initrd)
}

func availability() -> [String: Any] {
  func no(_ reason: String, _ detail: String? = nil) -> [String: Any] {
    var o: [String: Any] = ["ok": false, "reason": reason]
    if let d = detail { o["detail"] = d }
    return o
  }
  if !parentVerdict.trusted { return no("helper-untrusted", parentVerdict.detail) }
  // An arm64-only binary never runs on Intel, but the check stays for a
  // Rosetta-less future universal build.
  if sysctlInt("hw.optional.arm64") != 1 { return no("unsupported-hardware") }
  let v = ProcessInfo.processInfo.operatingSystemVersion
  if v.majorVersion < 15 {
    return no("unsupported-os", "macOS \(v.majorVersion).\(v.minorVersion)")
  }
  // SecureEnclave.isAvailable reports true inside a Tart guest (phase 0), so
  // it is not consulted. VZ is the honest signal: false inside a VM.
  if !VZVirtualMachine.isSupported {
    return sysctlInt("kern.hv_vmm_present") == 1 ? no("nested") : no("no-virtualization")
  }
  if guestAssets() == nil {
    return no("image-missing", GuestPins.rootHash.isEmpty ? "helper built without a guest image" : "guest kernel or initrd missing")
  }
  return ["ok": true]
}

func isAvailable() -> Bool { (availability()["ok"] as? Bool) == true }
