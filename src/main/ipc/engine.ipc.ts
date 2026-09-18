import { getProfileScopeUserId } from '../auth/scope'
import { getRuntimeModelCatalog } from '../services/runtimeModelCatalog'
import type { AgentEngine } from '../../shared/engine'
import { userActivation } from '../auth/activation'
import { engineBinaryService } from '../engine/engineBinaryService'
import { getMainWindow } from '../index'
import { ipcHandle } from './_wrap'
import { defaultEngineService } from '../services/localAgents/defaultEngineService'
import {
  ENGINE_BINARY_CHANNEL,
  isAgentEngine,
  type DefaultEngineDto,
  type EngineBinaryState
} from '../../shared/engine'

/**
 * The local engine's **binary**: whether this machine has one, and asking again.
 *
 * Two channels where there were four. Phase 3 of the agent runtime plan took the
 * shared `opencode serve` away — an agent's turn spawns its own child and speaks
 * ACP to it — so `engine:start` and `engine:stop` stopped meaning anything:
 * there is no server for a user to run, and the per-agent processes come and go
 * on their own between turns. `engine:skips` went with the shared config it
 * described.
 *
 * What is left is a file on disk, and the same three rules the old module had:
 *
 * - **No channel returns a path a renderer could execute or fetch.** It returns
 *   the resolved path as *text* for Settings to show, which is what it always
 *   did; nothing here hands over a handle.
 * - **`:resolve` does not throw on failure.** A failed resolution is a state
 *   Settings renders, and an `ipcMain.handle` rejection would drop the
 *   failure's code anyway (see `_wrap.ts`) — so the state, error sentence
 *   included, is the return value.
 * - **Nothing resolves at app boot.** The first resolution can mean a 46 MB
 *   download, and a user who never chats with a folder agent should never pay
 *   for it. It happens at the top of a turn, or when the user asks here.
 */
export function registerEngineHandlers(): void {
  ipcHandle('engine:model-catalog', (_event, engine: AgentEngine) => {
    userActivation.requireActivated()
    if (!isAgentEngine(engine)) throw new Error('Unknown runtime')
    return getRuntimeModelCatalog(getProfileScopeUserId(), engine)
  })

  // One subscription for the app's lifetime, forwarding transitions to whatever
  // window is open. Registered here rather than in the service so the service
  // keeps no Electron dependency at all.
  engineBinaryService.onChange((next) => {
    getMainWindow()?.webContents.send(ENGINE_BINARY_CHANNEL, next)
  })

  ipcHandle('engine:binary', (): EngineBinaryState => {
    userActivation.requireActivated()
    return engineBinaryService.state()
  })

  ipcHandle('engine:resolve', (): Promise<EngineBinaryState> => {
    userActivation.requireActivated()
    return engineBinaryService.refresh()
  })

  /**
   * This machine's **Default Runtime**, resolved.
   *
   * Resolved here rather than derived in the renderer from the setting plus the
   * detected tools, even though the renderer holds both. Two reasons, and the
   * first is the one this area has been bitten by: a panel that computes what
   * the launcher will do is a second implementation of it, and the two have
   * drifted before — over a credential reference, and over a model tier. The
   * second is movement: derived in the renderer, the answer would be "AI
   * credentials" for the fraction of a second detection is in flight and then
   * flip, swapping a picker under the pointer (ux_rules rule 1). One value that
   * is `undefined` until it is known cannot do that.
   *
   * It awaits detection, so it is the exact answer rather than the snapshot
   * `runtimeService` reads.
   */
  ipcHandle('engine:default-runtime', (): Promise<DefaultEngineDto> => {
    userActivation.requireActivated()
    return defaultEngineService.resolved()
  })
}
