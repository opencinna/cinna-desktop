/**
 * What the two folder drivers share: the reconcile against the folder, the
 * folder half of readiness, and answering a parked ask.
 *
 * `opencode` and `claude` run different transports (`LocalAgentTurnRunner`,
 * `ClaudeAgentTurnRunner`) over the same folder, the same pending-request
 * registry and the same grant store — so "this chat remembers a session",
 * "this ask is still waiting" and "you allowed this always" mean one thing
 * whichever engine answered. Phase 3 collapses both into `acp`.
 *
 * Takes its world by injection, like the runners: `index.ts` supplies the
 * production folder read, grant store and registry; a test supplies fakes.
 */
import type { AgentRow } from '../../db/agents'
import type { AgentTurnRunner } from '../../services/agentTurn/runner'
import type {
  LocalPermissionRequest,
  RequestResolution
} from '../../../shared/localAgentRequests'
import { createLogger } from '../../logger/logger'
import { capabilitiesFor } from './capabilities'
import { driverOfFolder } from './driverOf'
import type {
  AgentCapabilities,
  AgentDriver,
  AgentReadiness,
  ParkedAsk,
  ReadinessOptions,
  RespondOutcome,
  RunInput,
  RunResult
} from './driver'

const logger = createLogger('agent-driver')

export type FolderDriverId = 'opencode' | 'claude'

/** Shown when a folder agent's folder is gone — the runners' own sentence. */
export const FOLDER_NOT_FOUND = 'This agent’s folder could not be found on disk.'

/** The folder as it is on disk right now, reduced to what a driver decides on. */
export interface FolderView {
  name: string
  enabled: boolean
  /** `LocalAgentReadiness`. A string, because the runners' own view types it so. */
  readiness: string
  readinessReason: string | null
  /** The runtime block the engine is read from — the manifest's, or a bare folder's state. */
  runtime: { engine?: unknown } | null
}

export interface FolderDriverDeps {
  /** The runner this driver wraps, unchanged. */
  runner: AgentTurnRunner
  /** The folder, freshly read; null when it cannot be. Must not throw. */
  readFolder(userId: string, agentId: string): FolderView | null
  /**
   * Write an *Always allow* against the folder the ask came from. False when
   * the rule is not on disk — a real answer, not an error. Must not throw.
   */
  rememberGrant(agentId: string, request: LocalPermissionRequest): boolean
  /** Settle a parked ask in the pending-request registry; false when nothing waits on it. */
  resolveRequest(requestId: string, resolution: RequestResolution): boolean
  /**
   * The other folder driver, for a turn whose folder now names it. Omit to run
   * every turn on this driver regardless (a test of one runner).
   */
  sibling?(id: FolderDriverId): FolderDriver | undefined
}

export interface FolderDriver extends AgentDriver {
  readonly id: FolderDriverId
  /** Run on this driver's engine, skipping the reconcile. */
  runHere(userId: string, agent: AgentRow, input: RunInput): Promise<RunResult>
}

export interface FolderDriverExtras {
  /** More readiness rungs, asked only once the folder itself is `ok`. Must not throw. */
  readiness?(userId: string, agent: AgentRow, options?: ReadinessOptions): Promise<AgentReadiness>
}

export function createFolderDriver(
  id: FolderDriverId,
  deps: FolderDriverDeps,
  extras: FolderDriverExtras = {}
): FolderDriver {
  const driver: FolderDriver = {
    id,

    capabilities(agent): AgentCapabilities {
      return capabilitiesFor(agent)
    },

    async readiness(userId, agent, options) {
      try {
        const folder = folderReadiness(deps.readFolder(userId, agent.id))
        if (folder.state !== 'ok' || !extras.readiness) return folder
        return await extras.readiness(userId, agent, options)
      } catch (err) {
        // `readFolder` and the extra rungs promise not to throw; this is the
        // backstop that keeps a list from failing on the day one does.
        logger.warn('a folder agent’s readiness could not be read', {
          agentId: agent.id,
          error: err instanceof Error ? err.message : String(err)
        })
        return { state: 'invalid', reason: FOLDER_NOT_FOUND }
      }
    },

    async run(userId, agent, input) {
      // **The row is a cache; the folder is the truth** (Invariant 1). The
      // stored `driver` is what the scanner last read, and a manifest edited a
      // moment ago — by the Runtime card, or by an assistant — can name the
      // other engine before a rescan catches up. Dispatching on the stale
      // value sends a Claude agent to the OpenCode runner, which cannot find it
      // in the engine config and answers "try again in a moment" for ever. So
      // the turn reads the folder the way `resolveTurnRunner` used to, and
      // hands itself over when the folder disagrees.
      const target = reconcile(id, deps.readFolder(userId, agent.id))
      if (target !== id) {
        const other = deps.sibling?.(target)
        if (other) {
          logger.info('the folder names the other engine; running the turn there', {
            agentId: agent.id,
            stored: id,
            folder: target
          })
          return other.runHere(userId, agent, input)
        }
      }
      return driver.runHere(userId, agent, input)
    },

    runHere(_userId, agent, input) {
      return deps.runner.runTurn({
        chatId: input.chatId,
        agentId: agent.id,
        agentName: agent.name,
        wireContent: input.wireContent,
        fileIds: input.fileIds,
        signal: input.signal,
        onEvent: input.onEvent
      })
    },

    respond(ask, resolution) {
      return respondToParkedAsk(deps, ask, resolution)
    }
  }
  return driver
}

/**
 * Which folder driver the folder names right now.
 *
 * **Keeps the stored driver whenever the folder cannot speak for itself** — it
 * cannot be read, or it is `invalid` / `contract_too_new`. A manifest is
 * unparseable for a moment every time an assistant saves it, and its runtime
 * then reads as none, which would otherwise hand a Claude agent to the default
 * engine. Both runners refuse such a folder with the same sentence anyway, so
 * nothing is gained by moving it.
 */
function reconcile(stored: FolderDriverId, folder: FolderView | null): FolderDriverId {
  if (!folder || folder.readiness === 'invalid' || folder.readiness === 'contract_too_new') {
    return stored
  }
  return driverOfFolder(folder.runtime) === 'claude' ? 'claude' : 'opencode'
}

/** The folder half of readiness, in the scanner's own words. */
export function folderReadiness(folder: FolderView | null): AgentReadiness {
  if (!folder) return { state: 'invalid', reason: FOLDER_NOT_FOUND }
  switch (folder.readiness) {
    case 'ok':
      return { state: 'ok', reason: null }
    case 'credentials_needed':
    case 'invalid':
    case 'contract_too_new':
      return {
        state: folder.readiness,
        reason:
          folder.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
      }
    default:
      // A readiness this build does not know is not one it can vouch for.
      return {
        state: 'invalid',
        reason:
          folder.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
      }
  }
}

/**
 * Answer a parked ask: write an *Always allow* first, then settle the park.
 *
 * **Synchronous, and the order is only safe because it is.** The rule is
 * written before the answer is delivered, and `resolveRequest` can still
 * answer false — the turn was cancelled between the caller's registry lookup
 * and here — in which case a grant exists for an answer the user is told did
 * not land. Nothing can interleave today; an `await` inserted anywhere between
 * the lookup and the resolve makes it real, and the write cannot simply move
 * after the resolve because the resolution has to carry `remembered` into the
 * transcript.
 */
export function respondToParkedAsk(
  deps: Pick<FolderDriverDeps, 'rememberGrant' | 'resolveRequest'>,
  ask: ParkedAsk,
  resolution: RequestResolution
): RespondOutcome {
  const settled = rememberIfAlways(deps, ask, resolution)
  if (!deps.resolveRequest(ask.requestId, settled)) return { delivered: false }
  // Present only for a permission answered *always*: the block reads it to
  // decide between "remembered for this agent" and "allowed once — the rule
  // could not be saved".
  return resolution.kind === 'permission' &&
    resolution.reply === 'always' &&
    settled.kind === 'permission'
    ? { delivered: true, remembered: settled.remembered === true }
    : { delivered: true }
}

/**
 * Turn a user's *Always allow* into a rule stored beside the agent, and into
 * the `once` the engine is actually told.
 *
 * **Always is answered here, and never forwarded to the engine.** OpenCode's
 * own `always` writes `{projectID: "global", resource: "*"}` into a store
 * shared with the user's personal OpenCode install — no directory, no session,
 * no agent — so one click would authorise every folder agent, permanently
 * (`opencode_contract.md` §4). Replying `once` persists nothing there, so the
 * rule is kept beside the agent instead and matching asks are auto-answered
 * from it.
 *
 * `remembered` is deliberately allowed to be false: the user allowed this
 * action, so a store that refused the write must not cancel the action they
 * approved. They are asked again next time, and the block and the transcript
 * both say "allowed once" rather than claiming a rule that does not exist.
 *
 * Everything the grant is built from comes from the **engine's** ask, held in
 * the pending registry — never from the payload the renderer sent with the
 * answer.
 */
function rememberIfAlways(
  deps: Pick<FolderDriverDeps, 'rememberGrant'>,
  ask: ParkedAsk,
  resolution: RequestResolution
): RequestResolution {
  if (resolution.kind !== 'permission' || resolution.reply !== 'always') return resolution
  if (!ask.request) {
    logger.warn('an always answer arrived for a request with no recorded ask', {
      agentId: ask.agentId
    })
    return { kind: 'permission', reply: 'once', remembered: false }
  }
  return {
    kind: 'permission',
    reply: 'once',
    remembered: deps.rememberGrant(ask.agentId, ask.request)
  }
}
