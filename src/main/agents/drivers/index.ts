/**
 * Production wiring for the drivers, and the one resolver every caller uses.
 *
 * The drivers take their world by injection so they can be driven in a test
 * without a process, a port, a database or Electron. This module is where that
 * world is actually supplied — and it is the only file under `agents/drivers/`
 * that names `localAgentService`, `desktopStateService`, `a2aSessionRepo`, the
 * engine's binary resolver or Electron, so the dependency direction stays
 * one-way and the test files stay free of them.
 *
 * Phase 2 of the agent runtime plan moved this here from
 * `services/agentTurn/index.ts`, whose `resolveTurnRunner` it replaced. Phase 3
 * took the two folder drivers out again: one `acp` driver runs every local CLI
 * agent, and which engine it launches is a setting rather than an identity.
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { engineBinaryService } from '../../engine/engineBinaryService'
import { collectEngineConfigInput } from '../../engine/engineConfigSource'
import { a2aSessionRepo, type AgentRow } from '../../db/agents'
import { getSettingsScopeUserId } from '../../auth/scope'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { localAgentService } from '../../services/localAgents/localAgentService'
import { desktopStateService } from '../../services/localAgents/desktopStateService'
import { permissionGrantService } from '../../services/localAgents/permissionGrantService'
import { turnLock } from '../../services/localAgents/turnLock'
import { runAgentTurn } from '../../services/a2aStreamingService'
import { createLogger } from '../../logger/logger'
import { ClaudeAuthProbe } from '../../services/agentTurn/claudeAuth'
import { pendingRequests } from '../../services/agentTurn/pendingRequests'
import { toolDetectionService } from '../../services/localAgents/toolDetectionService'
import { runtimeService } from '../../services/localAgents/runtimeService'
import { providerService } from '../../services/providerService'
import {
  assembleAgentPrompt,
  assembleBareAgentPrompt,
  resolveDesktopPromptContext
} from '../../services/localAgents/promptAssembly'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { buildClaudeEnv } from '../../services/agentTurn/claudeEnv'
import { readFolderAgents } from '../../services/agentTurn/claudeAgents'
import { app } from 'electron'
import { fetchAgentCard } from '../a2a-client'
import type { LocalAgentKind } from '../../../shared/localAgents'
import type { LocalPermissionRequest } from '../../../shared/localAgentRequests'
import { DEFAULT_CLAUDE_APPROVAL } from '../../../shared/engine'
import type { AcpLauncherId, AgentDriverId } from '../../../shared/agentDrivers'
import { createA2aDriver } from './a2aDriver'
import { createAcpDriver, respondToAcpAsk, type AcpFolderView } from './acp/acpDriver'
import { createAcpProcessPool } from './acp/acpProcessPool'
import { startAcpConnection } from './acp/acpConnection'
import {
  createClaudeLauncher,
  createOpencodeLauncher,
  type AcpLauncher
} from './acp/acpLaunchers'
import { resolveAccessToken, resolveEndpointIfNeeded } from './a2aConnection'
import { driverOfRow } from './driverOf'
import type { AgentDriver, ParkedAsk, RespondOutcome } from './driver'

const logger = createLogger('agent-driver')

/* -------------------------------------------------------- the shared world */

/** The remembered session id for this (chat, agent), if any. */
function readSession(chatId: string, agentId: string): string | null {
  return a2aSessionRepo.getByChatAndAgent(chatId, agentId)?.contextId ?? null
}

/**
 * Remember it, in both stores.
 *
 * **Two stores, and the column names stay A2A-flavoured on purpose.**
 * `a2a_sessions.context_id` is what `agent:get-session` reads to decide a chat
 * is an agent chat, so a folder agent's engine session id goes there rather
 * than into a parallel table every existing reader would have to learn about.
 * `desktop.json` is the durable copy that travels with the folder — the SQLite
 * row is a cache, and Invariant 1 says it can be dropped and rebuilt.
 */
function saveSession(input: {
  chatId: string
  agentId: string
  agentDir: string
  agentKind: LocalAgentKind
  sessionId: string
}): void {
  a2aSessionRepo.upsert({
    chatId: input.chatId,
    agentId: input.agentId,
    contextId: input.sessionId,
    taskId: null,
    taskState: null
  })
  try {
    const state = desktopStateService.read(input.agentDir, input.agentKind)
    desktopStateService.patch(input.agentDir, input.agentKind, {
      sessions: {
        ...state.sessions,
        [input.chatId]: { sessionId: input.sessionId, updatedAt: Date.now() }
      }
    })
  } catch (err) {
    // The durable copy failing must not fail the turn: the SQLite row above
    // already carries continuity for this machine, and the folder copy is a
    // convenience for a folder that moves.
    logger.warn('could not record the engine session in desktop.json', {
      agentId: input.agentId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * **The reading half of *Always allow*.** The writing half is
 * {@link rememberGrant}, on the answer path, where the user is still waiting
 * and can be told whether the rule was actually saved. Both halves stay out of
 * the engine: OpenCode's own saved grants are per-project rows in a store
 * shared with the user's personal install, and Claude's live in `~/.claude` —
 * so the desktop keeps the rule beside the folder it was granted in and answers
 * the engine `allow_once` from it. See `permissionGrantService`.
 */
function isGranted(
  agentDir: string,
  agentKind: LocalAgentKind,
  request: LocalPermissionRequest
): boolean {
  return permissionGrantService.covers(agentDir, agentKind, request)
}

/**
 * Write a user's *Always allow* against the folder the ask came from.
 *
 * Lives here rather than in the IPC handler whose answer triggers it for two
 * reasons. This module is already the one place `localAgentService` and the
 * folder's own state are named together, so "which directory is this agent" is
 * answered once; and the alternative — reaching into the local-agent services
 * from `agent_a2a.ipc.ts` — pulls the whole folder stack (Electron `shell`, the
 * scaffolder, the watcher) into the chat IPC module's import graph.
 *
 * Returns whether the rule is on disk. False is a real answer, not an error:
 * the action the user approved still goes ahead, they are asked again next
 * time, and the block says so instead of claiming a rule that is not there.
 */
function rememberGrant(agentId: string, request: LocalPermissionRequest): boolean {
  try {
    // The DTO, not just its path: where an agent's state lives is a property of
    // the agent, and a probe of the folder for it can be wrong (see
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

/** Settle a parked ask in the pending-request registry. */
function resolveRequest(
  requestId: string,
  resolution: Parameters<typeof pendingRequests.resolve>[1]
): boolean {
  return pendingRequests.resolve(requestId, resolution) !== null
}

/* ----------------------------------------------------------- the ACP world */

/**
 * Whether the user's `claude` is logged in — one probe, shared by the turn
 * path, the launcher's readiness and the "Runs with" panel.
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

export const acpProcessPool = createAcpProcessPool({ start: startAcpConnection })

/**
 * How this build runs a Node program, and where the Claude ACP adapter is.
 *
 * Both live here rather than beside the launcher because both are Electron
 * questions, and this module is the only file under `agents/drivers/` allowed
 * to ask one.
 *
 * **There is no `node` to rely on.** A user who installed Cinna has Electron,
 * not necessarily a Node runtime, and picking one off `PATH` would run the
 * adapter on whatever version happens to be there. `ELECTRON_RUN_AS_NODE=1`
 * makes this app's own binary behave as the Node it already embeds.
 *
 * **Packaging note — read before changing `electron-builder.yml`.** The adapter
 * is `asarUnpack`ed, so the path below is a real file on disk. It has to be: a
 * child process reads the adapter with its own `fs`, and a path inside
 * `app.asar` is not a file to anything but Electron's patched reader. The
 * `files` entry that excludes the adapter's *nested* `claude-agent-sdk-*`
 * platform packages is what keeps the unpacked copy from carrying a second
 * ~190 MB `claude` the user never chose; `CLAUDE_CODE_EXECUTABLE` is what makes
 * that exclusion safe.
 */
function electronNodeRuntime(): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

const ADAPTER_PACKAGE = '@agentclientprotocol/claude-agent-acp'
const ADAPTER_ENTRY = 'dist/index.js'

function claudeAdapterEntry(): string {
  if (app.isPackaged) {
    const packaged = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      ADAPTER_PACKAGE,
      ADAPTER_ENTRY
    )
    if (!existsSync(packaged)) {
      throw new Error(`the Claude ACP adapter is not at ${packaged}`)
    }
    return packaged
  }
  // In development it is an ordinary dependency. Resolved rather than joined
  // from `process.cwd()`: the resolution follows npm's own layout, hoisted or
  // not, which is the same question `require` answers for every other import.
  return createRequire(import.meta.url).resolve(`${ADAPTER_PACKAGE}/${ADAPTER_ENTRY}`)
}

/** The `claude` this machine has. A fresh check detects again when there is none. */
async function claudePath(options?: { fresh?: boolean }): Promise<string | null> {
  const path = (await toolDetectionService.get('claude'))?.path ?? null
  if (path || !options?.fresh) return path
  // Detection is memoized for the life of the app, so *Check again* after
  // installing Claude Code would never see it.
  await toolDetectionService.refresh()
  return (await toolDetectionService.get('claude'))?.path ?? null
}

/**
 * The assembled folder prompt, not the SDK's `claude_code` preset: the preset
 * is a coding assistant's system prompt and the folder already says what this
 * agent is. A bare folder has no manifest, so nothing in the kit assembler
 * applies to it — the same split `collectEngineAgents` makes.
 */
function folderSystemPrompt(userId: string, agentId: string): string {
  const agent = localAgentService.get(userId, agentId)
  const context = resolveDesktopPromptContext()
  return agent.kind === 'bare'
    ? assembleBareAgentPrompt(agent.path, agent.name, context)
    : assembleAgentPrompt(agent.path, agent.manifest, context)
}

const acpLaunchers: Partial<Record<AcpLauncherId, AcpLauncher>> = {
  opencode: createOpencodeLauncher({
    // Through the service, which memoises per *configured path* and never
    // caches a failure — so a path the user has just fixed in Settings is tried
    // on the next turn rather than after a restart, and because the path feeds
    // the launch spec's key, the running child is replaced too.
    binary: () => engineBinaryService.ensure(),
    // `refreshModels: false` for the same reason the old reconcile passed it:
    // this runs once per turn, and a per-turn fan-out of provider API calls
    // would put network latency in front of every message the user sends. The
    // local credentials are still re-asked, because `ollama pull` happens
    // between one turn and the next.
    configInput: (userId) => collectEngineConfigInput(userId, { refreshModels: false }),
    configRoot: () => join(app.getPath('userData'), 'acp'),
    childEnv: async () => shellEnvForChild(await getShellEnv())
  }),
  claude: createClaudeLauncher({
    claudePath,
    // The login probe holds its answer for a short window; a fresh check asks
    // the binary now, so a `claude login` the user just ran counts.
    claudeAuth: (options) => (options?.fresh ? claudeAuthProbe.refresh() : claudeAuthProbe.status()),
    adapterEntry: claudeAdapterEntry,
    nodeRuntime: electronNodeRuntime,
    claudeEnv: async () =>
      buildClaudeEnv({ shellEnv: await getShellEnv(), appVersion: app.getVersion() }),
    systemPrompt: folderSystemPrompt,
    // A model **alias** (`haiku` / `sonnet` / `opus`), not a catalogue id: a
    // plan serves what the plan serves, and `runtimeService.resolve` returns the
    // alias for this engine. Null hands the choice to the CLI's own default.
    model: (userId, agentId) => {
      try {
        const agent = localAgentService.get(userId, agentId)
        return runtimeService.resolve(agent.runtime, providerService.listMerged()).modelId
      } catch {
        return null
      }
    },
    // The desktop's own decision, beside the grants it governs. The default is
    // applied here so the launcher never has to know that "no choice" exists.
    // Unreadable state falls to the default too: the turn still runs, and every
    // ask the classifier declines still reaches the permission block.
    approval: (userId, agentId) => {
      try {
        const agent = localAgentService.get(userId, agentId)
        return (
          desktopStateService.read(agent.path, agent.kind).claudeApproval ?? DEFAULT_CLAUDE_APPROVAL
        )
      } catch {
        return DEFAULT_CLAUDE_APPROVAL
      }
    },
    // Read fresh each turn, like the prompt: a subagent definition edited while
    // the app runs takes effect on the next turn, not the next launch.
    folderAgents: (agentPath) => readFolderAgents(agentPath).agents
  })
}

/**
 * The folder as it is on disk, for the driver's reconcile, its readiness and
 * its launcher's plan.
 *
 * A filesystem read, on the turn path — which is why it is guarded rather than
 * trusted. `localAgentService.get` throws `not_found` when the row is gone or
 * its folder moved; null then makes the turn keep the launcher its row names,
 * and the driver renders that state as a readable turn error of its own.
 */
function readAcpFolder(userId: string, agentId: string): AcpFolderView | null {
  try {
    const dto = localAgentService.get(userId, agentId)
    return {
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      path: dto.path,
      kind: dto.kind,
      enabled: dto.enabled,
      readiness: dto.readiness,
      readinessReason: dto.readinessReason,
      runtime: dto.runtime
    }
  } catch (err) {
    logger.warn('a folder agent could not be read; keeping the launcher its row names', {
      agentId,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

export const acpDriver = createAcpDriver({
  pool: acpProcessPool,
  launcher: (id) => acpLaunchers[id],
  readFolder: readAcpFolder,
  readSession,
  saveSession,
  isGranted,
  rememberGrant,
  registerRequest: (input) => pendingRequests.register(input),
  resolveRequest,
  withLock: (agentId, owner, fn, queuedSignal) => queuedSignal
    ? turnLock.withQueuedLock(agentId, owner, queuedSignal, fn) : turnLock.withLock(agentId, owner, fn)
})

/* ------------------------------------------------------------ the resolver */

const drivers: Record<AgentDriverId, AgentDriver> = {
  a2a: createA2aDriver({
    runTurn: runAgentTurn,
    resolveEndpoint: resolveEndpointIfNeeded,
    resolveAccessToken,
    fetchCard: fetchAgentCard,
    isReauthRequired: (err) => err instanceof CinnaReauthRequired
  }),
  acp: acpDriver
}

/**
 * Which driver runs an agent.
 *
 * The one dispatch point — the direct-chat IPC handler, the orchestrator's
 * agent tool and the answer path all ask it — so there is exactly one place to
 * look when asking "why did this agent take that path", and exactly one place
 * to change when another kind of agent arrives. Reads the row only: the ACP
 * driver checks the folder itself when it runs a turn, and picks its launcher
 * from what the folder says then.
 */
export function driverFor(agent: Pick<AgentRow, 'driver' | 'source'>): AgentDriver {
  return drivers[driverOfRow(agent)]
}

/**
 * Answer a parked ask whose agent row is gone.
 *
 * Removing an agents folder prunes its rows without waiting for the turn lock,
 * so a turn can still be parked on an agent no driver can be found for. Only
 * the ACP driver parks, and it shares the registry, so the answer is delivered
 * the way it delivers one — with no *Always allow* written, because there is no
 * agent left to keep a rule beside: `always` settles as `once`,
 * `remembered: false`. Synchronous, like `respond`.
 */
export function respondToOrphanedAsk(
  ask: ParkedAsk,
  resolution: Parameters<AgentDriver['respond']>[1]
): RespondOutcome {
  return respondToAcpAsk({ rememberGrant: () => false, resolveRequest }, ask, resolution)
}
