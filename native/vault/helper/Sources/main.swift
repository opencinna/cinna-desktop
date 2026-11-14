// VaultHelper: the Agent Vault trust base on macOS (docs/agents/vault/helper_tech.md).
// Child of Cinna; talks only over its own stdio (frames, Frames.swift).
// stdout carries frames and nothing else; logs go to stderr or `log` events.
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOFBF, 0)

#if VAULT_TEST_GATE
logStderr(TEST_GATE_MARKER)
#endif
logStderr("start: flavor \(FLAVOR.rawValue), version \(helperVersion), guest \(GuestPins.version.isEmpty ? "none" : GuestPins.version); \(parentVerdict.detail)")

FrameWriter.shared.onBroken = {
  logStderr("stdout closed; stopping")
  VaultManager.shared.stopAllAndExit(code: 0)
}

let reader = FrameReader(
  fd: 0,
  onFrame: { type, channel, payload in
    if type == .ctl {
      if channel != 0 { Control.emitLog("warn", "control frame on channel \(channel) ignored"); return }
      Control.handle(payload)
    } else {
      Channels.frame(type, channel, payload)
    }
  },
  onEnd: { error in
    if let e = error { logStderr("protocol error: \(e); stopping") }
    VaultManager.shared.stopAllAndExit(code: error == nil ? 0 : 2)
  })
reader.start()
LockWatcher.shared.start()

// RunLoop, not dispatchMain: distributed and NSWorkspace notifications need a
// running CFRunLoop on the main thread; it services the main queue as well.
RunLoop.main.run()
