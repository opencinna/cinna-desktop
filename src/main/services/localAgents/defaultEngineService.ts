/**
 * This machine's **Default runtime** — what a folder agent that names no engine
 * of its own runs on.
 *
 * One setting (`localAgentsDefaultEngine`), written **once**, and one fact about
 * the machine (is there a `claude`) used to write it. `resolveDefaultEngine` in
 * `shared/` is what combines them, so the renderer's label and this process's
 * dispatch cannot drift.
 *
 * ## Why it exists at all
 *
 * A desktop installed by someone who has never configured an API key used to
 * have no runtime for local agents: every agent that declared nothing fell to
 * the default chat mode, and a machine with no chat mode has none. But the same
 * user very often already has Claude Code installed, logged in and paid for.
 * That observation is the feature: the first runtime *found* becomes the
 * default, so a fresh install runs agents before anyone configures anything.
 *
 * ## Detected once, then locked
 *
 * The detection decides the setting **on the first launch that can answer it**
 * and never again ({@link lockIfUnset}). It is not re-derived per read, and
 * that is a deliberate reversal: a live answer moves an agent onto a different
 * engine — and onto a different *permission model* — because the user installed
 * an unrelated CLI, with nothing on screen at the moment it changes. Locking
 * keeps the promise the picker makes: the runtime you are shown is the runtime
 * you get until you press something.
 *
 * Two consequences worth stating, because both are choices:
 *
 * - a machine with nothing installed locks to the OpenCode runner, and a
 *   `claude` installed **later** is adopted by one click on the picker, not by
 *   restarting. The picker shows it as installed-and-not-selected, which is a
 *   visible invitation rather than a silent change;
 * - an install that **already runs folder agents** locks to the OpenCode runner
 *   whatever is detected. Those agents have been running on a credential the
 *   user chose; moving them to a subscription and to Claude Code's own
 *   permission reviewer because the app was upgraded is the billing-and-safety
 *   surprise this area's rules exist to prevent. The picker is one click away
 *   for anyone who wants it.
 *
 * ## Two readers, two shapes
 *
 * {@link current} is synchronous because its callers are: `runtimeService.resolve`
 * runs inside the scanner, the DTO mapper and the engine's config assembly.
 * It reads the setting, and — only on the first launch, before the lock is
 * written — the detection **snapshot**.
 *
 * {@link resolved} awaits detection and is what the renderer asks for. The
 * difference matters exactly once in the life of an install — between the first
 * launch's window opening and its lock being written — because after that both
 * read a stored string and agree by construction. In that window the
 * synchronous side answers with the OpenCode runner, which is the conservative
 * direction: it spends a key the user configured rather than a subscription
 * they have not chosen here. The lock re-indexes the agent rows when it lands,
 * so nothing stays built on that first answer.
 */

import { appSettingsService } from '../appSettingsService'
import { agentRepo } from '../../db/agents'
import { createLogger } from '../../logger/logger'
import { toolDetectionService } from './toolDetectionService'
import {
  DEFAULT_AGENT_ENGINE,
  isAgentEngine,
  resolveDefaultEngine,
  type AgentEngine,
  type DefaultEngineDto
} from '../../../shared/engine'

const logger = createLogger('default-runtime')

/** The one settling pass, shared by everything that waits for it. */
let settling: Promise<AgentEngine | null> | null = null

/**
 * The setting, read through a `try`.
 *
 * The same rule `runtimeService`'s credential override follows: this is read on
 * paths that must not fail because a settings read did, and "Automatic" is the
 * correct answer when the store cannot be reached.
 */
function setting(): string {
  try {
    return appSettingsService.getAll().localAgentsDefaultEngine.trim()
  } catch {
    return ''
  }
}

/** Whether the detection pass that has finished found a usable `claude`. */
function installed(tools: { id: string; available: boolean }[] | null, id: string): boolean {
  return (tools ?? []).some((tool) => tool.id === id && tool.available)
}

export const defaultEngineService = {
  /** The pinned value, or `''` for Automatic. */
  setting,

  /**
   * What an agent that names no engine runs on, from the detection snapshot.
   *
   * Synchronous. A machine whose first detection pass has not finished reads as
   * "no claude", which resolves Automatic to the OpenCode path — the behaviour
   * every build before this setting had, and the conservative direction: it
   * spends a key the user configured rather than a subscription they did not
   * choose here.
   */
  current(): AgentEngine {
    const tools = toolDetectionService.snapshot()
    return resolveDefaultEngine(setting(), installed(tools, 'claude'), installed(tools, 'codex'))
  },

  /**
   * The same answer, with detection awaited.
   *
   * The await matters only on the first launch, before {@link lockIfUnset} has
   * written a value: after that the setting is the answer and no pass is
   * needed. It is what the renderer asks for, so no surface has to combine a
   * setting and a detection list for itself.
   */
  async resolved(): Promise<DefaultEngineDto> {
    const pinned = setting()
    if (isAgentEngine(pinned)) return { engine: pinned }
    const tools = await toolDetectionService.list()
    return { engine: resolveDefaultEngine(pinned, installed(tools, 'claude'), installed(tools, 'codex')) }
  },

  /**
   * Decide the Default runtime from what this machine has — **once, ever**.
   *
   * Fired at startup, after detection. Returns the value it wrote, or null when
   * there was already one (every launch after the first) — the caller uses that
   * to decide whether the agent rows need re-indexing, since
   * `driver_config.launcher` caches this answer.
   *
   * Never throws. It runs on the startup path and the worst outcome of a failed
   * write is that the next launch tries again, which is strictly better than a
   * desktop that does not open.
   */
  lockIfUnset(): Promise<AgentEngine | null> {
    // **Memoized, because two callers want the same one pass.** Startup fires
    // it, and `settings:get-all` awaits it so the renderer never reads the
    // undecided `''` — which it would otherwise cache and render as "no runtime
    // selected" until something invalidated it, on precisely the first launch
    // this feature exists for. After the first launch it returns before its
    // first await, so that read costs nothing.
    return (settling ??= settle())
  }
}

/**
 * The lock itself. See {@link defaultEngineService.lockIfUnset}, which memoizes
 * it — this runs at most once per launch.
 */
async function settle(): Promise<AgentEngine | null> {
  try {
    if (setting() !== '') return null
    const tools = await toolDetectionService.list()
    const claudeAvailable = installed(tools, 'claude')
    const codexAvailable = installed(tools, 'codex')
    /**
     * Detection is a login-shell probe and the picker is live while it runs.
     * A runtime the user chose in that window is a decision already made, and
     * the write below would have overwritten it with the machine's guess.
     */
    if (setting() !== '') {
      logger.info('the default runtime was set while detection ran; keeping it')
      return null
    }
    /**
     * An install with folder agents in it is not a fresh one, and its agents
     * have a runtime they have been running on. See the header: this is the
     * line that stops an upgrade from re-homing them.
     */
    const established = agentRepo.countFolderAgents() > 0
    const engine = established ? DEFAULT_AGENT_ENGINE : resolveDefaultEngine('', claudeAvailable, codexAvailable)
    // Through the service, so the value is validated exactly as the picker's
    // own write is — one gate, not two.
    appSettingsService.set('localAgentsDefaultEngine', engine)
    logger.info('locked the default runtime for this machine', {
      engine,
      claudeAvailable,
      codexAvailable,
      established
    })
    return engine
  } catch (err) {
    logger.warn('could not lock the default runtime', {
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}
