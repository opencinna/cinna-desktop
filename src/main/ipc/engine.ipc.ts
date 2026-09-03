import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { engineManager, registerEngineShutdown } from '../engine/engineManager'
import { getMainWindow } from '../index'
import { ipcHandle } from './_wrap'
import { ENGINE_STATE_CHANNEL, type EngineSkips, type EngineState } from '../../shared/engine'

/**
 * The local engine: its state, and starting or stopping it.
 *
 * Thin controllers. Three things are deliberately **not** here:
 *
 * - **No channel returns the engine's base URL or its auth password.** They stay
 *   inside `engineManager`, so a component cannot be written that talks to the
 *   engine directly and routes around the turn runner Phase 6 owns.
 * - **`:start` does not throw on failure.** A failed start is a state the
 *   readiness strip renders, and an `ipcMain.handle` rejection would drop the
 *   failure's code anyway (see `_wrap.ts`) — so the state, error sentence
 *   included, is the return value.
 * - **Nothing starts the engine at app boot.** The first start can mean a 50 MB
 *   download, and a user who never opens the Agents tab should never pay for
 *   it. Starting is an explicit act: Settings, or the first turn (Phase 6).
 */
export function registerEngineHandlers(): void {
  registerEngineShutdown()

  // One subscription for the app's lifetime, forwarding transitions to whatever
  // window is open. Registered here rather than in `engineManager` so the
  // manager keeps no Electron dependency beyond `app`.
  engineManager.onStateChange((next) => {
    getMainWindow()?.webContents.send(ENGINE_STATE_CHANNEL, next)
  })

  ipcHandle('engine:status', (): EngineState => {
    userActivation.requireActivated()
    return engineManager.getState()
  })

  ipcHandle('engine:start', (): Promise<EngineState> => {
    userActivation.requireActivated()
    return engineManager.ensureRunning(getSettingsScopeUserId())
  })

  /**
   * Which folder agents the running config left out, and why.
   *
   * Read on demand rather than pushed: it only ever changes when the config is
   * regenerated, and every regeneration moves the engine state, which the
   * renderer is already subscribed to.
   */
  ipcHandle('engine:skips', (): EngineSkips => {
    userActivation.requireActivated()
    return engineManager.lastSkips()
  })

  ipcHandle('engine:stop', async (): Promise<EngineState> => {
    userActivation.requireActivated()
    await engineManager.stop()
    return engineManager.getState()
  })
}
