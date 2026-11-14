// Build flavor (D31) and the constants the whole helper shares.
// Flavor is fixed at compile time: scripts/vault/build-helper.sh passes
// VAULT_DEV or VAULT_TEST_GATE in SWIFT_ACTIVE_COMPILATION_CONDITIONS; a build
// with neither is the release flavor.
import Foundation

enum Flavor: String {
  case release, dev, test
}

#if VAULT_TEST_GATE
let FLAVOR: Flavor = .test
#elseif VAULT_DEV
let FLAVOR: Flavor = .dev
#else
let FLAVOR: Flavor = .release
#endif

let HELPER_PROTOCOL = 1
let TEAM_ID = "G5E484HA2U"
/// electron-builder.yml `appId`: the codesign identifier of the Cinna app that may drive us.
let PARENT_IDENTIFIER = "io.opencinna.desktop"
/// D35: the dev flavor keeps its keys in its own group (VaultHelper.dev.entitlements;
/// the Developer ID profile grants G5E484HA2U.*), so a dev build never touches
/// the release group's Secure Enclave key, signing key or rollback digests.
#if VAULT_DEV
let KEYCHAIN_GROUP = "G5E484HA2U.io.opencinna.desktop.vault-helper.dev"
let KEYCHAIN_SERVICE = "io.opencinna.desktop.vault-helper.dev"
#else
let KEYCHAIN_GROUP = "G5E484HA2U.io.opencinna.desktop.vault-helper"
let KEYCHAIN_SERVICE = "io.opencinna.desktop.vault-helper"
#endif

#if VAULT_TEST_GATE
/// L2: compiled into the test flavor only. scripts/packaged-dependencies.cjs
/// (verifyVaultHelper) refuses to package a binary that contains it, whatever
/// its Info.plist says. main.swift logs it so the optimiser keeps it.
let TEST_GATE_MARKER = "CINNA-VAULT-TEST-GATE-BUILD:7c1e9a4f-do-not-ship"

/// Test-only knobs read from the environment (never compiled into release or dev).
func testEnvMs(_ name: String, min: Int = 100) -> Int? {
  if let s = ProcessInfo.processInfo.environment[name], let v = Int(s), v >= min { return v }
  return nil
}
#endif

/// D13: how long a vault stays unlocked after its last hold release or gated action is the
/// vault's own `lockAfterMs` (vault.json). The test flavor alone lets
/// CINNA_VAULT_TEST_WINDOW_MS override every vault's for the smoke run; nil = no override.
let TEST_WINDOW_OVERRIDE_MS: Int? = {
  #if VAULT_TEST_GATE
  if let s = ProcessInfo.processInfo.environment["CINNA_VAULT_TEST_WINDOW_MS"], let v = Int(s), v >= 100 { return v }
  #endif
  return nil
}()
/// protocol.ts VAULT_LOCK_TIMEOUTS: 30 s, 5 min, or 0 = no idle timer (locks when Cinna quits,
/// and on screen lock / sleep / logout as always).
let LOCK_TIMEOUTS: Set<Int64> = [30_000, 300_000, 0]
/// protocol.ts VAULT_DEFAULT_LOCK_AFTER_MS: new vaults, and files written before the setting existed.
let DEFAULT_LOCK_AFTER_MS: Int64 = 300_000
/// Orders timeouts by how long they keep a vault open: 0 (no timer) is the longest.
func lockTimeoutRank(_ ms: Int64) -> Int64 { ms == 0 ? Int64.max : ms }
/// D40: a hold keeps the window open for at most this long.
let HOLD_MAX_MS: Int = {
  #if VAULT_TEST_GATE
  if let v = testEnvMs("CINNA_VAULT_TEST_HOLD_MAX_MS") { return v }
  #endif
  return 4 * 60 * 60_000
}()
/// D33: a locked (paused) VM is stopped cold after this long.
let PAUSED_STOP_MS: Int = {
  #if VAULT_TEST_GATE
  if let s = ProcessInfo.processInfo.environment["CINNA_VAULT_TEST_PAUSED_STOP_MS"], let v = Int(s), v >= 100 { return v }
  #endif
  return 30 * 60_000
}()

/// Approval token lifetimes (protocol.ts APPROVAL_TTL_MS).
let APPROVAL_TTL_MS: [String: Int64] = [
  "move-in": 30 * 60_000, "install": 30 * 60_000, "export": 10 * 60_000, "move-out": 30 * 60_000,
  "egress": 10 * 60_000, "terminal": 10 * 60_000, "resize": 10 * 60_000, "destroy": 10 * 60_000,
  "lock-timeout": 10 * 60_000,
]
let GATED_ACTIONS: Set<String> = Set(APPROVAL_TTL_MS.keys)
/// Tokens the guest (vaultd) verifies with the per-boot approval key.
let GUEST_VERIFIED_ACTIONS: Set<String> = ["move-in", "install", "export", "move-out", "terminal"]
/// Tokens the helper verifies itself with its per-process key.
let HELPER_VERIFIED_ACTIONS: Set<String> = ["egress", "resize", "destroy", "lock-timeout"]

let VAULT_ENGINES: Set<String> = ["claude", "codex", "opencode", "antigravity"]
/// protocol.ts VAULT_INSTALL_HOSTS: open in the proxy while a move-in/install approval is live.
let VAULT_INSTALL_HOSTS = ["releases.astral.sh", "github.com", "*.githubusercontent.com", "pypi.org", "files.pythonhosted.org"]

let MIN_VAULT_SIZE: Int64 = 1 << 30
let MAX_VAULT_SIZE: Int64 = 2 << 40

/// vsock ports (spec §2).
let PORT_EGRESS: UInt32 = 1080
let PORT_BOOT: UInt32 = 1090
let PORT_VAULTD: UInt32 = 5000
let PORT_HELPER_CONTROL: UInt32 = 5001

let helperVersion: String =
  (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
