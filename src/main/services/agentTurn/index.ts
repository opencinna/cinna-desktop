/**
 * Production wiring for the runner seam, and the one resolver every caller uses.
 *
 * The runner classes take their world by injection so they can be driven in a
 * test without a process, a port, a database or Electron. This module is where
 * that world is actually supplied — and it is the only place `engineManager`,
 * `localAgentService`, `desktopStateService` and `a2aSessionRepo` are named
 * together, so the dependency direction stays one-way and the test files stay
 * free of them.
 */

import { engineManager } from '../../engine/engineManager'
import { a2aSessionRepo } from '../../db/agents'
import { getSettingsScopeUserId } from '../../auth/scope'
import { localAgentService } from '../localAgents/localAgentService'
import { desktopStateService } from '../localAgents/desktopStateService'
import { turnLock } from '../localAgents/turnLock'
import { runAgentTurn, type RunAgentTurnInput, type RunAgentTurnResult } from '../a2aStreamingService'
import { createLogger } from '../../logger/logger'
import { EngineEventBus } from './engineEventBus'
import { LocalAgentTurnRunner, type LocalTurnDeps } from './localAgentTurnRunner'
import { isFolderAgent, type AgentTurnRunner } from './runner'
import type { AgentRow } from '../../db/agents'
import { describeEngineSkip } from '../../../shared/runtimeMessages'

const logger = createLogger('agent-turn')

/**
 * The one global subscription to the engine's event stream.
 *
 * One `opencode serve` backs every folder agent, so one bus serves every turn.
 * It connects on the first subscriber and disconnects on the last, so an idle
 * desktop holds nothing open — which is why constructing it at module load
 * costs nothing.
 */
export const engineEventBus = new EngineEventBus(async (signal) => {
  const res = await engineManager.request('/api/event', {
    signal,
    headers: { Accept: 'text/event-stream' }
  })
  if (!res.ok) throw new Error(`the engine event stream responded ${res.status}`)
  return res.body
})

/**
 * Drop every listener when the engine stops.
 *
 * Session ids belong to the process that issued them, so a turn still waiting
 * on `ses_…` after a restart is waiting on something that no longer exists.
 * Telling the listeners is what lets those turns end as an error the user can
 * read instead of hanging.
 */
engineManager.onStateChange((next) => {
  if (next.status !== 'running') engineEventBus.shutdown()
})

/**
 * `A2ATurnRunner` — today's `runAgentTurn`, unchanged, behind the shared shape.
 *
 * The narrowing here is the whole reason `RunAgentTurnInput` could be widened
 * without weakening the A2A path: `runAgentTurn` still demands an endpoint and
 * a card, and this is the single place that proves it has them.
 */
export const a2aTurnRunner: AgentTurnRunner = {
  async runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    if (!input.endpointUrl || !input.cardUrl) {
      return {
        text: '',
        parts: [],
        notices: [],
        error: {
          message: 'This agent has no endpoint configured.',
          raw: `missing ${input.endpointUrl ? 'cardUrl' : 'endpointUrl'} for ${input.agentId}`
        }
      }
    }
    return runAgentTurn({ ...input, endpointUrl: input.endpointUrl, cardUrl: input.cardUrl })
  }
}

const localDeps: LocalTurnDeps = {
  ensureEngineRunning: async (userId) => {
    const state = await engineManager.ensureRunning(userId)
    return { status: state.status, error: state.error }
  },
  agentKey: (agentId) => engineManager.agentKey(agentId),
  agentModel: (agentId) => engineManager.agentModel(agentId),
  // Through the shared describer: this is shown to the user as a whole turn
  // error, and the code used to arrive as a sentence fragment ("its runtime
  // names no model") that read as a non-sentence on its own.
  skipReason: (agentId) => {
    const code = engineManager.lastSkips().agents.find((a) => a.agentId === agentId)?.code
    return code ? describeEngineSkip(code) : null
  },
  request: (path, init) => engineManager.request(path, init),
  bus: engineEventBus,
  getAgent: (userId, agentId) => {
    try {
      const dto = localAgentService.get(userId, agentId)
      return {
        name: dto.name,
        path: dto.path,
        enabled: dto.enabled,
        readiness: dto.readiness,
        readinessReason: dto.readinessReason
      }
    } catch (err) {
      // `get` throws `not_found` when the row is gone or its folder moved. The
      // runner renders that as a turn error, so it must not escape as one.
      logger.warn('a folder agent could not be read for a turn', {
        agentId,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  },
  readSession: (chatId, agentId) =>
    a2aSessionRepo.getByChatAndAgent(chatId, agentId)?.contextId ?? null,
  saveSession: ({ chatId, agentId, agentDir, sessionId }) => {
    // **Two stores, and the column names stay A2A-flavoured on purpose.**
    // `a2a_sessions.context_id` is what `agent:get-session` reads to decide a
    // chat is an agent chat, so a folder agent's engine session id goes there
    // rather than into a parallel table that every existing reader would have
    // to learn about. `desktop.json` is the durable copy that travels with the
    // folder — the SQLite row is a cache and Invariant 1 says it can be dropped
    // and rebuilt.
    a2aSessionRepo.upsert({
      chatId,
      agentId,
      contextId: sessionId,
      taskId: null,
      taskState: null
    })
    try {
      const state = desktopStateService.read(agentDir)
      desktopStateService.patch(agentDir, {
        sessions: { ...state.sessions, [chatId]: { sessionId, updatedAt: Date.now() } }
      })
    } catch (err) {
      // The durable copy failing must not fail the turn: the SQLite row above
      // already carries continuity for this machine, and the folder copy is a
      // convenience for a folder that moves.
      logger.warn('could not record the engine session in desktop.json', {
        agentId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },
  withLock: (agentId, owner, fn) => turnLock.withLock(agentId, owner, fn),
  userId: () => getSettingsScopeUserId()
}

export const localAgentTurnRunner = new LocalAgentTurnRunner(localDeps)

/**
 * Which runner an agent's turn goes through.
 *
 * The one dispatch point, used by both call sites — the direct-chat IPC handler
 * and `A2AAsMcpProvider.callTool` — so there is exactly one place to look when
 * asking "why did this agent take that path", and exactly one place to change
 * when a third kind of agent arrives.
 */
export function resolveTurnRunner(agent: Pick<AgentRow, 'source'>): AgentTurnRunner {
  return isFolderAgent(agent) ? localAgentTurnRunner : a2aTurnRunner
}
