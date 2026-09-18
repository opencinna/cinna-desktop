import { getProfileScopeUserId } from '../auth/scope'
import { getRuntimeModelCatalog } from '../services/runtimeModelCatalog'
import type { AgentEngine } from '../../shared/engine'
import { userActivation } from '../auth/activation'
import { claudeBinaryService, codexBinaryService, engineBinaryService } from '../engine/engineBinaryService'
import { getMainWindow } from '../index'
import { claudeAuthProbe, codexAuthProbe } from '../agents/drivers'
import { appSettingsService } from '../services/appSettingsService'
import { ipcHandle } from './_wrap'
import { defaultEngineService } from '../services/localAgents/defaultEngineService'
import {
  CLAUDE_BINARY_CHANNEL,
  CODEX_BINARY_CHANNEL,
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
   * A saved OpenCode Path takes effect when it is saved, as Codex's and
   * Claude's do below — see the Codex handler for why. OpenCode has no login
   * probe to invalidate.
   */
  appSettingsService.onSaved('localAgentsEnginePath', () => {
    void engineBinaryService.refresh()
  })

  /**
   * The **managed Codex CLI**, on the same three rules and the same state shape
   * as the OpenCode binary above — deliberately, so Settings renders both rows
   * from one vocabulary. Its own push channel, so neither row can be painted
   * with the other's state; it also carries download progress, which at ~90 MB
   * is a wait somebody watches.
   *
   * `:codex-resolve` returns a failed install **as state**: the renderer
   * branches on it (the row's sentence and its *Try again*), and a rejection
   * would arrive as `Error invoking remote method…` with the code gone.
   */
  codexBinaryService.onChange((next) => {
    getMainWindow()?.webContents.send(CODEX_BINARY_CHANNEL, next)
  })

  /**
   * **A saved Codex Path takes effect when it is saved.** The service memoises
   * per configured path, but only a *turn* asked it — so until one ran, the
   * Runtime row, the picker and the login state went on describing the old
   * binary, and a row left red by a failed install stayed red above a path that
   * would have fixed it. Started, never awaited: clearing the path starts a
   * ~90 MB download, and `settings:set` must not hold the field's save for it.
   * Transitions reach the renderer over {@link CODEX_BINARY_CHANNEL} as always.
   * The login cache goes too: it is kept thirty seconds whatever binary it asked.
   */
  appSettingsService.onSaved('localAgentsCodexPath', () => {
    codexAuthProbe.invalidate()
    void codexBinaryService.refresh()
  })

  /**
   * **Unresolved in this run is not "not installed"** — so both pinned-CLI rows
   * are read through {@link EngineBinaryService.peek}, which looks once without
   * downloading (a managed copy from an earlier run, an exact-version install
   * of the user's own) and remembers what it found. The login probe reads the
   * same answer, so a row cannot say "ready" beside a login that says "unknown".
   */
  ipcHandle('engine:codex-binary', (): Promise<EngineBinaryState> => {
    userActivation.requireActivated()
    return codexBinaryService.peek()
  })

  ipcHandle('engine:codex-resolve', (): Promise<EngineBinaryState> => {
    userActivation.requireActivated()
    return codexBinaryService.refresh()
  })

  /**
   * The **pinned Claude Code CLI**: the Codex trio again — state, resolve, and
   * a saved path taking effect when it is saved — over the Claude service.
   */
  claudeBinaryService.onChange((next) => {
    getMainWindow()?.webContents.send(CLAUDE_BINARY_CHANNEL, next)
  })

  appSettingsService.onSaved('localAgentsClaudePath', () => {
    claudeAuthProbe.invalidate()
    void claudeBinaryService.refresh()
  })

  ipcHandle('engine:claude-binary', (): Promise<EngineBinaryState> => {
    userActivation.requireActivated()
    return claudeBinaryService.peek()
  })

  ipcHandle('engine:claude-resolve', (): Promise<EngineBinaryState> => {
    userActivation.requireActivated()
    return claudeBinaryService.refresh()
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
