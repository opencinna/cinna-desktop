// D21: locking the Mac locks every vault. The helper watches for it itself, so
// a compromised Cinna cannot keep a vault open across a screen lock.
import AppKit
import Foundation

final class LockWatcher {
  static let shared = LockWatcher()
  private var tokens: [NSObjectProtocol] = []
  private var signalSource: DispatchSourceSignal?

  func start() {
    let dnc = DistributedNotificationCenter.default()
    tokens.append(dnc.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in
      VaultManager.shared.lockAll(why: "screen locked")
    })
    let ws = NSWorkspace.shared.notificationCenter
    let events: [(Notification.Name, String)] = [
      (NSWorkspace.willSleepNotification, "Mac going to sleep"),
      (NSWorkspace.sessionDidResignActiveNotification, "user switched away"),
      (NSWorkspace.willPowerOffNotification, "logout or shutdown"),
    ]
    for (name, why) in events {
      tokens.append(ws.addObserver(forName: name, object: nil, queue: .main) { _ in
        VaultManager.shared.lockAll(why: why)
      })
    }
    #if VAULT_TEST_GATE
    // The smoke and live lanes cannot lock the real screen: SIGUSR1 stands in for it.
    signal(SIGUSR1, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
    s.setEventHandler { VaultManager.shared.lockAll(why: "test signal (screen lock stand-in)") }
    s.resume()
    signalSource = s
    #endif
  }
}
