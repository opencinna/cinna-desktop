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
import { permissionGrantService } from '../localAgents/permissionGrantService'
import { turnLock } from '../localAgents/turnLock'
import { runAgentTurn, type RunAgentTurnInput, type RunAgentTurnResult } from '../a2aStreamingService'
import { createLogger } from '../../logger/logger'
import { EngineEventBus } from './engineEventBus'
import { LocalAgentTurnRunner, type LocalTurnDeps } from './localAgentTurnRunner'
import { ClaudeAgentTurnRunner, type ClaudeTurnDeps } from './claudeAgentTurnRunner'
import { ClaudeAuthProbe } from './claudeAuth'
import { isFolderAgent, type AgentTurnRunner } from './runner'
import { toolDetectionService } from '../localAgents/toolDetectionService'
import { runtimeService } from '../localAgents/runtimeService'
import { providerService } from '../providerService'
import { assembleAgentPrompt, assembleBareAgentPrompt, resolveDesktopPromptContext } from '../localAgents/promptAssembly'
import { getShellEnv } from '../../shell/env'
import { buildClaudeEnv } from './claudeEnv'
import { app } from 'electron'
import type { AgentRow } from '../../db/agents'
import { describeEngineSkip } from '../../../shared/runtimeMessages'
import type { LocalPermissionRequest } from '../../../shared/localAgentRequests'
import { DEFAULT_AGENT_ENGINE, type AgentEngine } from '../../../shared/engine'

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
        kind: dto.kind,
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
  saveSession: ({ chatId, agentId, agentDir, agentKind, sessionId }) => {
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
      const state = desktopStateService.read(agentDir, agentKind)
      desktopStateService.patch(agentDir, agentKind, {
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
  // **The reading half of *Always allow*.** The writing half is on the answer
  // path (`agent_a2a.ipc.ts`), where the user is still waiting and can be told
  // whether the rule was actually saved. Both halves stay out of the engine:
  // OpenCode's own saved grants are user-global — one row authorising every
  // folder agent, shared with the user's personal OpenCode install — so the
  // desktop keeps the rule beside the folder it was granted in and answers
  // `once` from it. See `permissionGrantService`.
  isGranted: (agentDir, agentKind, request) =>
    permissionGrantService.covers(agentDir, agentKind, request),
  withLock: (agentId, owner, fn) => turnLock.withLock(agentId, owner, fn),
  userId: () => getSettingsScopeUserId()
}

export const localAgentTurnRunner = new LocalAgentTurnRunner(localDeps)

/**
 * The world the Claude runner takes, supplied here for the same reason the
 * local one's is: this module is the only place `toolDetectionService`,
 * `promptAssembly`, `runtimeService` and Electron's `app` are named together,
 * so the runner itself stays drivable in a test with no binary and no Electron.
 *
 * `getAgent`, `readSession`, `saveSession`, `withLock` and `userId` are the
 * **same implementations** the OpenCode path uses — deliberately, because
 * "this agent is busy in another chat" and "this chat remembers a session"
 * must not mean two different things depending on which engine answered.
 */
/**
 * Whether the user's `claude` is logged in — one probe, shared by the turn path
 * and by the "Runs with" panel.
 *
 * **Built on the same environment the turn runs in**, and that is the whole
 * reason it is wired here rather than constructed at either call site. This
 * binary answers differently depending on its child environment — withholding
 * `USER` makes a logged-in install report *"Not logged in"* — so a probe run
 * under the full shell environment would report a login for a child that then
 * cannot authenticate. Readiness would be answering about a different process
 * than the one the turn spawns.
 */
export const claudeAuthProbe = new ClaudeAuthProbe({
  claudePath: async () => (await toolDetectionService.get('claude'))?.path ?? null,
  env: async () => buildClaudeEnv({ shellEnv: await getShellEnv(), appVersion: app.getVersion() })
})

const claudeDeps: ClaudeTurnDeps = {
  getAgent: localDeps.getAgent,
  readSession: localDeps.readSession,
  saveSession: localDeps.saveSession,
  withLock: localDeps.withLock,
  userId: localDeps.userId,
  // The same grant store the OpenCode path reads. A grant is scoped to a
  // folder, and the key gains no engine segment — but the *action* it is stored
  // under is the engine's own vocabulary, so a rule written for OpenCode's
  // `bash` never silently authorises Claude's `Bash`.
  isGranted: localDeps.isGranted,
  // The assembled folder prompt, not the SDK's `claude_code` preset: the preset
  // is a coding assistant's system prompt and the folder already says what this
  // agent is. A bare folder has no manifest, so nothing in the kit assembler
  // applies to it — the same split `collectEngineAgents` makes.
  systemPrompt: (userId, agentId) => {
    const agent = localAgentService.get(userId, agentId)
    const context = resolveDesktopPromptContext()
    return agent.kind === 'bare'
      ? assembleBareAgentPrompt(agent.path, agent.name, context)
      : assembleAgentPrompt(agent.path, agent.manifest, context)
  },
  // A model **alias** (`haiku` / `sonnet` / `opus`), not a catalogue id: a plan
  // serves what the plan serves, and `runtimeService.resolve` returns the alias
  // for this engine. Null hands the choice to the CLI's own default.
  model: (userId, agentId) => {
    try {
      const agent = localAgentService.get(userId, agentId)
      return runtimeService.resolve(agent.runtime, providerService.listMerged()).modelId
    } catch {
      return null
    }
  },
  claudePath: async () => (await toolDetectionService.get('claude'))?.path ?? null,
  claudeAuth: () => claudeAuthProbe.status(),
  shellEnv: () => getShellEnv(),
  appVersion: () => app.getVersion()
}

export const claudeAgentTurnRunner = new ClaudeAgentTurnRunner(claudeDeps)

/**
 * Write a user's *Always allow* against the folder the ask came from.
 *
 * Lives here rather than in the IPC handler that calls it for two reasons.
 * This module is already the one place `localAgentService` and the folder's own
 * state are named together, so "which directory is this agent" is answered
 * once; and the alternative — reaching into the local-agent services from
 * `agent_a2a.ipc.ts` — pulls the whole folder stack (Electron `shell`, the
 * scaffolder, the watcher) into the chat IPC module's import graph.
 *
 * Returns whether the rule is on disk. False is a real answer, not an error:
 * the action the user approved still goes ahead, they are asked again next
 * time, and the block says so instead of claiming a rule that is not there.
 */
export function rememberPermissionGrant(
  agentId: string,
  request: LocalPermissionRequest
): boolean {
  try {
    // The DTO, not just its path: where an agent's state lives is a property
    // of the agent, and a probe of the folder for it can be wrong (see
    // `desktopStatePath`).
    const agent = localAgentService.get(getSettingsScopeUserId(), agentId)
    permissionGrantService.remember(agent.path, agent.kind, request)
    return true
  } catch (err) {
    logger.warn('could not remember a permission grant', {
      agentId,
      error: err instanceof Error ? err.message : String(err)
    })
    return false
  }
}

/**
 * Which runner an agent's turn goes through.
 *
 * The one dispatch point, used by both call sites — the direct-chat IPC handler
 * and `A2AAsMcpProvider.callTool` — so there is exactly one place to look when
 * asking "why did this agent take that path", and exactly one place to change
 * when a third kind of agent arrives.
 */
export function resolveTurnRunner(agent: Pick<AgentRow, 'source' | 'id'>): AgentTurnRunner {
  if (!isFolderAgent(agent)) return a2aTurnRunner
  return folderEngine(agent.id) === 'claude' ? claudeAgentTurnRunner : localAgentTurnRunner
}

/**
 * Which engine a folder agent's manifest asks for.
 *
 * A filesystem read, on the turn path — which is why it is guarded rather than
 * trusted. `localAgentService.get` throws `not_found` when the row is gone or
 * its folder moved, and a manifest is unparseable for a moment every time an
 * assistant saves it. **Falling back to the default engine is the safe
 * direction**: the OpenCode runner already renders every one of those states as
 * a readable turn error, whereas dispatching to the Claude runner on a folder
 * we could not read would replace them with "no Claude Code was found".
 *
 * An unrecognised engine value resolves to the default too — the contract's
 * tolerant read, applied at the last place it could still be forgotten.
 */
function folderEngine(agentId: string): AgentEngine {
  try {
    const dto = localAgentService.get(getSettingsScopeUserId(), agentId)
    return runtimeService.resolve(dto.runtime, providerService.listMerged()).engine
  } catch (err) {
    logger.warn('could not read a folder agent’s engine; using the default', {
      agentId,
      error: err instanceof Error ? err.message : String(err)
    })
    return DEFAULT_AGENT_ENGINE
  }
}
