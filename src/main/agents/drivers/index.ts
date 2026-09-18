import { recordRuntimeModelCatalog } from '../../services/runtimeModelCatalog'
import { chatConductorService, isChatConductor, conductorContext } from '../../services/chatConductorService'
import { isCoordinatorHandover } from '../../../shared/kit/handovers'
/**
 * Production wiring for the drivers, and the one resolver every caller uses.
 *
 * The drivers take their world by injection so they can be driven in a test
 * without a process, a port, a database or Electron. This module is where that
 * world is actually supplied — and it is the only file under `agents/drivers/`
 * that names `localAgentService`, `desktopStateService`, `agentSessionRepo`, the
 * engine's binary resolver or Electron, so the dependency direction stays
 * one-way and the test files stay free of them.
 *
 * Phase 2 of the agent runtime plan moved this here from
 * `services/agentTurn/index.ts`, whose `resolveTurnRunner` it replaced. Phase 3
 * took the two folder drivers out again: one `acp` driver runs every local CLI
 * agent, and which engine it launches is a setting rather than an identity.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { applyConductorToolPolicy } from './acp/conductorToolPolicy'
import { prepareCodexConductorPolicy } from './acp/codexConductorPolicy'
import { aiFunctionRuntimePoolKey, syntheticRuntimePoolKey, utilityAgentId } from '../../services/syntheticRuntimePooling'
import { TITLE_SYSTEM_PROMPT } from '../../services/aiFunctionPrompts'
import type { ConductorContext } from '../../services/chatConductorService'
import { engineAgentKey } from '../../engine/configGenerator'
import { join } from 'node:path'
import { codexBinaryService, engineBinaryService } from '../../engine/engineBinaryService'
import { knownCodexBinary } from '../../engine/binaryResolver'
import { ManagedAssetError } from '../../managed/managedAsset'
import { collectEngineConfigInput } from '../../engine/engineConfigSource'
import { agentRepo, agentSessionRepo, type AgentRow } from '../../db/agents'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { localAgentService } from '../../services/localAgents/localAgentService'
import { desktopStateService } from '../../services/localAgents/desktopStateService'
import { permissionGrantService } from '../../services/localAgents/permissionGrantService'
import { turnLock } from '../../services/localAgents/turnLock'
import { runAgentTurn } from '../../services/a2aStreamingService'
import { createLogger } from '../../logger/logger'
import { CodexAuthProbe } from './acp/codexAuth'
import { buildCodexEnv } from './acp/codexEnv'
import { CODEX_NOT_INSTALLED, codexBinaryKnownFrom, createCodexLauncher } from './acp/codexLauncher'
import { codexEffortForComplexity, isAgentEngine } from '../../../shared/engine'
import { isWorkComplexity } from '../../../shared/modelFamilies'
import { ClaudeAuthProbe } from './acp/claudeAuth'
import { pendingRequests } from './pendingRequests'
import { toolDetectionService } from '../../services/localAgents/toolDetectionService'
import { runtimeService } from '../../services/localAgents/runtimeService'
import { defaultEngineService } from '../../services/localAgents/defaultEngineService'
import { providerService } from '../../services/providerService'
import {
  assembleAgentPrompt,
  assembleBareAgentPrompt,
  assembleBareNativePrompt,
  resolveDesktopPromptContext,
  type NativeRuntimeEngine
} from '../../services/localAgents/promptAssembly'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { buildClaudeEnv } from './acp/claudeEnv'
import { readFolderAgents } from './acp/claudeAgents'
import { app } from 'electron'
import { fetchAgentCard } from '../a2a-client'
import type { LocalAgentKind } from '../../../shared/localAgents'
import type { AcpRuntimeMode } from './acp/types'
import type { LocalPermissionRequest } from '../../../shared/localAgentRequests'
import { DEFAULT_CLAUDE_APPROVAL } from '../../../shared/engine'
import type { AcpLauncherId, AgentDriverId } from '../../../shared/agentDrivers'
import { createA2aDriver } from './a2aDriver'
import { createA2aTurnRecoverer } from './a2aTurnRecoverer'
import { createAcpDriver, respondToAcpAsk, type AcpFolderView } from './acp/acpDriver'
import { acpProcessPool } from './acp/acpPool'
import { sessionActivityHub } from '../../services/sessionActivityHub'
import { installChatSessionForgetter } from '../../services/chatSessionRelease'
import { installSessionActivityStopper } from '../../services/sessionActivityStop'
export { acpProcessPool } from './acp/acpPool'
acpProcessPool.onStatus((agentId, state) => {
  if (state.state === 'stopped' || state.state === 'exited') {
    void import('../../services/conductorBridge').then(({ conductorBridge }) => conductorBridge.abortAgent(agentId))
      .catch((error) => logger.warn('Could not close conductor calls after runtime exit', { agentId, error: String(error) }))
  }
})
import { developmentAgentContext, contextForDevelopmentAgent, restoreDevelopmentContext, isDevelopmentAgent, developmentPlanKey } from '../../localdev/developmentSessionService'
import { localDevService } from '../../localdev/localDevService'
import { customAgentService } from '../../services/customAgentService'
import type { AcpRuntimeView } from './acp/acpRuntime'
import {
  createClaudeLauncher,
  createOpencodeLauncher,
  type AcpLauncher,
  type AcpLaunchPlan
} from './acp/acpLaunchers'
import { resolveAccessToken, resolveEndpointIfNeeded } from './a2aConnection'
import { driverOfRow } from './driverOf'
import { unsupportedDriver } from './unsupportedDriver'
import { createManagedDriver } from './managed/managedDriver'
import { createManagedTurnRecoverer } from './managed/managedTurnRecoverer'
import { agentService } from '../../services/agentService'
import { managedAgentService } from '../../services/managedAgentService'
import type { AgentDriver, ParkedAsk, RespondOutcome, ReadinessOptions } from './driver'

const logger = createLogger('agent-driver')

/* -------------------------------------------------------- the shared world */

/** The remembered session id for this (chat, agent), if any. */
function readSession(chatId: string, agentId: string): string | null {
  return agentSessionRepo.getByChatAndAgent(chatId, agentId)?.contextId ?? null
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
  agentSessionRepo.upsert({
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
 * adapter's hoisted runtime dependencies must also be unpacked: Node's ESM
 * resolver cannot find packages left inside the adjacent `app.asar`.
 * `npm run test:packaged:acp -- <executable> <resources>` checks the handshake
 * against a built app without starting a model turn. The
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
 * The system prompt one turn runs on, for the engine that is about to run it.
 *
 * Two different documents, because the two runtime modes run in two different
 * places. An **isolated** session gets the whole assembled prompt, which
 * replaces the engine's own preset: the preset is a coding assistant's system
 * prompt and the folder already says what this agent is. A **native** session
 * runs on the folder's own setup — the engine loads its instructions file, its
 * settings, its hooks and its MCP servers itself — so it gets only the
 * desktop's context, to be appended to the engine's preset.
 *
 * The engine is baked in per launcher because the two read different files by
 * themselves: `assembleBareNativePrompt` pastes the folder's instructions in
 * only for the engine that would not read *that* file.
 *
 * Called on every plan, so a folder edited between two turns takes effect on
 * the next one. `mode` is the field the driver put on the folder view for this
 * turn, the same one the launcher branched its session options on — one
 * decision, no way for the prompt and the options to disagree.
 *
 * OpenCode is deliberately absent: its prompt travels through the generated
 * config (`engineConfigSource.collectEngineConfigInput`), and a bare OpenCode
 * agent keeps the whole assembled prompt there until that path is settled.
 */
function folderSystemPrompt(
  engine: NativeRuntimeEngine
): (userId: string, agentId: string, mode: AcpRuntimeMode) => string {
  return (userId, agentId, mode) => {
    const synthetic = syntheticRuntimeProfiles.get(agentId)
    if (synthetic?.userId === userId) return synthetic.context.instructions
    const utility = aiFunctionProfiles.get(agentId)
    if (utility?.userId === userId) return utility.systemPrompt
    const conductor = agentRepo.getOwned(userId, agentId)
    if (conductor && isChatConductor(conductor)) return conductorContext(conductor).instructions
    const development = developmentAgentContext(userId, agentId)
    if (development) return development.instructions
    const agent = localAgentService.get(userId, agentId)
    // The agent's own id, which is stable per agent — see
    // `DesktopPromptContext.agentId` for why a per-turn id could not go here.
    const context = { ...resolveDesktopPromptContext(), agentId }
    if (mode === 'native') {
      return assembleBareNativePrompt(agent.path, agent.name, context, engine)
    }
    // An isolated bare folder is not reachable through `readAcpFolder` today —
    // a development agent is the only isolated folder with no manifest, and it
    // returned above. Kept explicit anyway: the failure it would otherwise
    // cause is a folder answering on the kit assembler's "no instructions yet"
    // stub, which reads as a broken agent rather than as a wiring mistake.
    return agent.kind === 'bare'
      ? assembleBareAgentPrompt(agent.path, agent.name, context)
      : assembleAgentPrompt(agent.path, agent.manifest, context)
  }
}

/**
 * Whether Codex is logged in — asked of **the binary the sessions run on**: the
 * explicit Settings path, else the managed pinned copy. Never the PATH copy,
 * which `toolDetectionService` still reports for "Open in…" and which no
 * spawned session uses any more.
 *
 * The login follows `HOME`, not the binary (verified against 0.153.4 and
 * 0.154), so the managed CLI under the same child environment reports the
 * user's own login. `knownCodexBinary` never downloads: before the first
 * install there is simply nothing to ask, and the probe answers `unknown`.
 */
export const codexAuthProbe = new CodexAuthProbe({
  path: knownCodexBinary,
  env: async () => buildCodexEnv({ shellEnv: await getShellEnv() })
})

const syntheticRuntimeProfiles = new Map<string, { userId: string; context: ConductorContext }>()
const aiFunctionProfiles = new Map<string, { userId: string; modelId: string | null; credentialId: string | null; systemPrompt: string }>()

/** Process cwd is stable; acpDriver/AI Functions supply their own session cwd. */
function codexProcessCwd(poolKey: string): string {
  const path = join(app.getPath('userData'), 'chat-conductors', 'processes', createHash('sha256').update(poolKey).digest('hex'))
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

/** A dedicated utility profile owns a warm process, but never owns resumable sessions. */
export async function prepareAiFunctionRuntime(userId: string, systemPrompt: string, warmOnly: boolean): Promise<{
  poolKey: string; plan: AcpLaunchPlan; cwd: string
}> {
  const runtime = runtimeService.resolve(undefined, providerService.listMerged())
  if (runtime.reason) throw new Error(runtime.reason)
  const engine = runtime.launcher
  // OpenCode instructions are process config; Claude and Codex own them per session.
  let poolKey = aiFunctionRuntimePoolKey(userId, engine, runtime.credentialId ?? null, runtime.modelId ?? null, engine === 'opencode' ? systemPrompt : null)
  // Claude shares a process across function prompts, but instruction files are
  // session-owned too: concurrent functions must never rewrite each other's cwd.
  const digest = createHash('sha256').update(JSON.stringify([poolKey, systemPrompt])).digest('hex').slice(0, 24)
  // Claude's process configuration is independent of the per-session prompt
  // and native tool list. A fresh sealed utility session may reuse this
  // profile's warm chat process, without loading that chat's session/history.
  const liveAgents = agentRepo.list(userId).filter((agent) => agent.driver === 'acp' && acpProcessPool.status(agent.id).state === 'running')
  const compatibleCandidates = engine === 'claude' ? liveAgents.map((agent) => agent.id) : []
  const chatCandidate = (engine === 'codex' || (engine === 'opencode' && systemPrompt === TITLE_SYSTEM_PROMPT)) ? liveAgents.find((agent) => {
    if (!isChatConductor(agent)) return false
    const context = conductorContext(agent)
    return context.engine === engine && context.credentialId === runtime.credentialId && context.modelId === runtime.modelId
  }) : undefined
  if (warmOnly && acpProcessPool.status(poolKey).state !== 'running' && compatibleCandidates.length === 0 && !chatCandidate) {
    throw new Error('AI function deferred until the default runtime is warm')
  }
  const cwd = join(app.getPath('userData'), 'chat-conductors', 'ai-functions', digest)
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    // The patched Codex adapter accepts exact per-session developer instructions.
    // Do not duplicate function instructions into repository/user-message context.
    if (engine === 'codex') rmSync(join(cwd, name), { force: true })
    else writeFileSync(join(cwd, name), `${systemPrompt}\n`, { mode: 0o600 })
  }
  aiFunctionProfiles.set(poolKey, { userId, modelId: runtime.modelId, credentialId: runtime.credentialId, systemPrompt })
  const launcher = acpLaunchers[engine]
  if (!launcher) throw new Error('The default runtime cannot run AI functions')
  const chatContext = chatCandidate ? conductorContext(chatCandidate) : undefined
  const candidateKey = chatContext ? syntheticRuntimePoolKey(userId, chatContext) : poolKey
  if (chatContext) syntheticRuntimeProfiles.set(candidateKey, { userId, context: chatContext })
  const restrict = async (proposed: AcpLaunchPlan): Promise<AcpLaunchPlan> => applyConductorToolPolicy(engine === 'codex'
    ? await prepareCodexConductorPolicy(proposed, join(app.getPath('userData'), 'acp')) : proposed, engine)
  let proposed = await launcher.plan({ userId, agentId: candidateKey, folder: {
    name: 'AI Functions', slug: 'ai-functions', description: 'One-shot AI function', path: engine === 'codex' ? codexProcessCwd(candidateKey) : chatContext?.path ?? cwd, kind: 'bare', runtimeMode: 'isolated'
  } })
  if ('error' in proposed) throw new Error(proposed.error)
  let plan = await restrict(proposed)
  if (chatCandidate) {
    if (acpProcessPool.peek?.(candidateKey, plan.spec.key)) {
      // Hold the process identity, not the chat alias: deleting or changing
      // that chat while a title runs must not move the utility's ownership.
      poolKey = candidateKey
      if (engine === 'opencode') plan = { ...plan, setup: { ...plan.setup, configOptions: plan.setup.configOptions?.map((option) => option.configId === 'mode'
        ? { ...option, value: engineAgentKey(utilityAgentId(candidateKey), 'ai-function') } : option) } }
    } else {
      if (warmOnly) throw new Error('AI function deferred until the default runtime is warm')
      // A credential/environment change can make a live chat process stale.
      // Drafting is allowed to start its dedicated utility process instead.
      proposed = await launcher.plan({ userId, agentId: poolKey, folder: {
        name: 'AI Functions', slug: 'ai-functions', description: 'One-shot AI function', path: engine === 'codex' ? codexProcessCwd(poolKey) : cwd, kind: 'bare', runtimeMode: 'isolated'
      } })
      if ('error' in proposed) throw new Error(proposed.error)
      plan = await restrict(proposed)
    }
  }
  plan = { ...plan, init: { ...plan.init, clientCapabilities: {} }, session: { ...plan.session, mcpServers: [] } }
  if (engine === 'codex') plan.session.meta = { ...plan.session.meta, cinna: { systemPrompt } }
  if (engine === 'claude') {
    const meta = plan.session.meta ?? {}
    const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined
    plan.session.meta = { ...meta, claudeCode: { ...claude, options: { ...claude?.options, systemPrompt } } }
    const warmKey = [poolKey, ...compatibleCandidates].find((key) => acpProcessPool.peek?.(key, plan.spec.key))
    if (warmKey) poolKey = warmKey
  }
  return { poolKey, plan, cwd }
}

const acpLaunchers: Partial<Record<AcpLauncherId, AcpLauncher>> = {
  codex: createCodexLauncher({
    // Through the service, like OpenCode's `binary` below: memoised per
    // configured path, concurrent turns share one download, and a failure is
    // never cached. The resolver's messages are this app's own remedy-first
    // sentences, so they are safe to show; anything else (a raw `fetch failed`)
    // becomes the generic one.
    binary: async () => {
      try {
        return { path: (await codexBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : CODEX_NOT_INSTALLED }
      }
    },
    binaryKnown: (options) => codexBinaryKnownFrom({
      state: () => codexBinaryService.state(),
      refresh: () => codexBinaryService.refresh(),
      known: knownCodexBinary
    }, options),
    auth: (options) => options?.fresh ? codexAuthProbe.refresh() : codexAuthProbe.status(),
    adapterEntry: () => {
      const entry = '@agentclientprotocol/codex-acp/dist/index.js'
      const path = app.isPackaged
        ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', entry)
        : createRequire(import.meta.url).resolve(entry)
      if (!existsSync(path)) throw new Error('Codex ACP adapter is missing')
      return path
    },
    nodeRuntime: electronNodeRuntime,
    env: async () => buildCodexEnv({ shellEnv: await getShellEnv() }),
    systemPrompt: folderSystemPrompt('codex'),
    settings: (userId, agentId) => {
      const synthetic = syntheticRuntimeProfiles.get(agentId)
      if (synthetic?.userId === userId) return { model: synthetic.context.modelId, effort: 'medium', approval: 'ask' }
      const utility = aiFunctionProfiles.get(agentId)
      if (utility?.userId === userId) return { model: utility.modelId, effort: 'medium', approval: 'ask' }
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return { model: conductorContext(conductor).modelId, effort: 'medium', approval: 'ask' }
      const development = developmentAgentContext(userId, agentId)
      if (development) return { model: null, effort: codexEffortForComplexity(development.complexity), approval: 'ask' }
      const agent = localAgentService.get(userId, agentId)
      return {
        model: typeof agent.runtime?.model === 'string' ? agent.runtime.model.trim() || null : null,
        effort: codexEffortForComplexity(isWorkComplexity(agent.runtime?.complexity) ? agent.runtime.complexity : null),
        approval: desktopStateService.read(agent.path, agent.kind).codexApproval ?? 'ask'
      }
    }
  }),
  custom: customAgentService.launcher,
  opencode: createOpencodeLauncher({
    companionAgentIds: (ctx) => syntheticRuntimeProfiles.has(ctx.agentId) ? [utilityAgentId(ctx.agentId)] : [],
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
    configInput: async (userId) => {
      const input = await collectEngineConfigInput(userId, { refreshModels: false })
      for (const [agentId, synthetic] of syntheticRuntimeProfiles) {
        if (synthetic.userId !== userId) continue
        const context = synthetic.context
        input.agents.push({ agentId, slug: 'chat-runtime', description: 'Chat runtime', prompt: context.instructions, providerId: context.credentialId ?? '', modelId: context.modelId ?? '', permissionMode: 'replace', permissions: context.toolPolicy === 'none' ? { '*': 'deny' } : { '*': 'deny', 'cinna_*': 'allow' } })
        input.agents.push({ agentId: utilityAgentId(agentId), slug: 'ai-function', description: 'Chat title', prompt: TITLE_SYSTEM_PROMPT, providerId: context.credentialId ?? '', modelId: context.modelId ?? '', permissionMode: 'replace', permissions: { '*': 'deny' } })
      }
      for (const [agentId, utility] of aiFunctionProfiles) {
        if (utility.userId === userId) input.agents.push({ agentId, slug: 'ai-function', description: 'One-shot AI function', prompt: utility.systemPrompt, providerId: utility.credentialId ?? '', modelId: utility.modelId ?? '', permissionMode: 'replace', permissions: { '*': 'deny' } })
      }
      for (const row of agentRepo.list(userId).filter(isChatConductor)) {
        const context = conductorContext(row)
        input.agents.push({ agentId: row.id, slug: `chat-${row.id}`, description: 'Chat runtime', prompt: context.instructions, providerId: context.credentialId ?? '', modelId: context.modelId ?? '', permissionMode: 'replace', permissions: context.toolPolicy === 'none' ? { '*': 'deny' } : { '*': 'deny', 'cinna_*': 'allow' } })
      }
      for (const row of agentRepo.list(userId).filter(isDevelopmentAgent)) {
        try {
          const context = contextForDevelopmentAgent(row)
          input.agents.push({ agentId: row.id, slug: `cinna-build-${row.id}`, description: row.description ?? '',
            prompt: context.instructions, providerId: context.runtime.credentialId ?? '', modelId: context.runtime.modelId ?? '' })
        } catch { /* Other profiles and previous runtimes are deliberately excluded. */ }
      }
      return input
    },
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
    systemPrompt: folderSystemPrompt('claude'),
    // A model **alias** (`haiku` / `sonnet` / `opus`), not a catalogue id: a
    // plan serves what the plan serves, and `runtimeService.resolve` returns the
    // alias for this engine. Null hands the choice to the CLI's own default.
    model: (userId, agentId) => {
      const synthetic = syntheticRuntimeProfiles.get(agentId)
      if (synthetic?.userId === userId) return synthetic.context.modelId
      const utility = aiFunctionProfiles.get(agentId)
      if (utility?.userId === userId) return utility.modelId
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return conductorContext(conductor).modelId
      const development = developmentAgentContext(userId, agentId)
      if (development) return development.runtime.modelId
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
    // the app runs takes effect on the next turn, not the next launch. Kit
    // folders only — the launcher does not ask for a bare folder's, which load
    // from its own settings.
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
      // **The one place the rule lives.** A bare folder is somebody's own
      // repository, adopted for its instructions file alone, so a turn in it
      // is the turn a terminal session there would get; a kit folder is the
      // harness the desktop scaffolded and stays sealed.
      runtimeMode: dto.kind === 'bare' ? 'native' : 'isolated',
      enabled: dto.enabled,
      readiness: dto.readiness,
      readinessReason: dto.readinessReason,
      runtime: dto.runtime,
      coordinatorHandback: dto.kind === 'kit' && Array.isArray(dto.manifest.handovers) && dto.manifest.handovers.some(isCoordinatorHandover)
    }
  } catch (err) {
    logger.warn('a folder agent could not be read; keeping the launcher its row names', {
      agentId,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

async function readAcpRuntime(userId: string, agent: AgentRow, options?: ReadinessOptions): Promise<AcpRuntimeView | null> {
  if (isChatConductor(agent)) return chatConductorService.runtime(userId, agent)
  if (isDevelopmentAgent(agent)) {
    const context = await restoreDevelopmentContext(agent, options)
    const state = customAgentService.runtime(userId, agent)
    return {
      ...state, type: 'folder',
      // `kind: 'bare'` because this workspace has no manifest — but
      // **`runtimeMode: 'isolated'`**: it is a folder the desktop synced for
      // its own build session, not a repository the user adopted, and it runs
      // on the instructions `developmentContext` assembled rather than on
      // whatever `.claude/settings.json` the workspace happens to carry.
      folder: { name: agent.name, slug: `cinna-build-${agent.id}`, description: agent.description ?? '',
        path: context.workspacePath, kind: 'bare', runtimeMode: 'isolated',
        enabled: agent.enabled, readiness: 'ok', readinessReason: null,
        runtime: { engine: context.runtime.launcher } },
      validate(chatId) { state.validate(chatId); contextForDevelopmentAgent(agent) }
    }
  }
  if (agent.source === 'local' && agent.driverConfig?.launcher === 'custom') return customAgentService.runtime(userId, agent)
  const folder = readAcpFolder(userId, agent.id)
  if (!folder) return null
  return {
    type: 'folder', folder, validate() {},
    readSession: (chatId) => readSession(chatId, agent.id),
    saveSession: (chatId, sessionId) => saveSession({ chatId, agentId: agent.id, agentDir: folder.path, agentKind: folder.kind, sessionId }),
    isGranted: (request) => isGranted(folder.path, folder.kind, request),
    rememberGrant: (request) => { permissionGrantService.remember(folder.path, folder.kind, request); return true }
  }
}

export const acpDriver = createAcpDriver({
  recordModelCatalog: (userId, launcher, metadata) => {
    if (isAgentEngine(launcher)) recordRuntimeModelCatalog(userId, launcher, metadata)
  },
  pool: acpProcessPool,
  prepareConductor: async (userId, agent, input, plan, stop, wake) => {
    const { conductorBridge } = await import('../../services/conductorBridge')
    return conductorBridge.prepare(userId, agent, input, plan, stop, wake)
  },
  conductorAbandoned: (chatId, agentId, reason) => {
    void import('../../services/conductorBridge').then(({ conductorBridge }) => conductorBridge.abandonWaiters(chatId, agentId, reason))
      .catch((error) => logger.warn('Could not release conductor calls after an abandoned follow-up', { agentId, error: String(error) }))
  },
  buildPrompt: (userId, input, connection) => import('../../services/acpAttachments').then(({ buildAcpPrompt }) => buildAcpPrompt(userId, input, connection)),
  replayTranscript: (chatId, messageId, connection, userId, agentId) => import('../../services/conductorTranscript').then(({ replayTranscript }) => replayTranscript(chatId, messageId, connection, userId, agentId)),
  launcher: (id) => {
    const launcher = acpLaunchers[id]
    if (!launcher) return undefined
    return { ...launcher, async plan(ctx) {
      const agent = agentRepo.getOwned(ctx.userId, ctx.agentId)
      if (agent && isChatConductor(agent) && ctx.folder) {
        const context = conductorContext(agent)
        const poolKey = syntheticRuntimePoolKey(ctx.userId, context)
        syntheticRuntimeProfiles.set(poolKey, { userId: ctx.userId, context })
        // Codex includes its process cwd in the launch identity. Keep that
        // profile-owned while acpDriver supplies each chat's own session cwd.
        const processCwd = id === 'codex' ? codexProcessCwd(poolKey) : ctx.folder.path
        let plan = await launcher.plan({ ...ctx, agentId: poolKey, folder: { ...ctx.folder, path: processCwd, slug: 'chat-runtime' } })
        if ('error' in plan) return plan
        if (id === 'codex') {
          try { plan = await prepareCodexConductorPolicy(plan, join(app.getPath('userData'), 'acp')) }
          catch (error) {
            return { error: error instanceof Error && error.message.startsWith('Codex cannot enforce the chat tool policy:')
              ? error.message : 'Codex chat policy could not be verified. Check the installed runtime.' }
          }
        }
        acpProcessPool.share?.(ctx.agentId, poolKey)
        return plan
      }
      const development = developmentAgentContext(ctx.userId, ctx.agentId)
      if (!development) return launcher.plan(ctx)
      const execution = await localDevService.executionContext(development.profileId)
      const plan = await launcher.plan(ctx)
      developmentAgentContext(ctx.userId, ctx.agentId)
      if ('error' in plan) return plan
      // Keep runtime credential/environment policy; add only the managed CLI tools.
      const path = execution.env.PATH ?? plan.spec.env.PATH ?? ''
      return { ...plan, spec: { ...plan.spec, env: { ...plan.spec.env, PATH: path },
        key: developmentPlanKey(plan.spec.key, path) } }
    } }
  },
  readRuntime: readAcpRuntime,
  defaultEngine: () => defaultEngineService.current(),
  registerRequest: (input) => pendingRequests.register(input),
  resolveRequest,
  withLock: (agentId, owner, fn, queuedSignal) => queuedSignal
    ? turnLock.withQueuedLock(agentId, owner, queuedSignal, fn) : turnLock.withLock(agentId, owner, fn),
  // Subagents and background processes a session reports, for the composer's badges.
  activity: sessionActivityHub,
  // A turn the agent starts between the user's turns becomes a run of the
  // chat. Imported when first needed: the service reaches this module back
  // through the run service.
  openFollowUp: (request) => {
    void import('../../services/followUpTurnService')
      .then(({ followUpTurnService }) => followUpTurnService.open(request))
      .catch((err: unknown) => {
        logger.error('the follow-up turn service could not be loaded', { error: err instanceof Error ? err.message : String(err) })
        request.abandon('the follow-up turn service could not be loaded')
      })
  }
})
// A trashed chat, or one that answers to another agent now, stops hearing its old sessions.
installChatSessionForgetter((chatId, agentId) => acpDriver.forgetChatSessions(chatId, agentId))
// Stop on a background process the composer's popover lists.
installSessionActivityStopper('acp', acpDriver.activityStopper)

/** Relaunch recovery of `a2a` turns, with the driver's own credential resolution. */
export const a2aTurnRecoverer = createA2aTurnRecoverer({
  resolveEndpoint: resolveEndpointIfNeeded,
  resolveAccessToken,
  isReauthRequired: (err) => err instanceof CinnaReauthRequired
})

/** Relaunch recovery of `managed` turns, with the driver's own binding resolution. */
export const managedTurnRecoverer = createManagedTurnRecoverer({
  findAgent: (settingsUserId, profileUserId, agentId) => agentService.findAgent(settingsUserId, profileUserId, agentId),
  readiness: (agent) => managedAgentService.readiness(agent),
  prepare: (ownerId, agent, chatId) => managedAgentService.prepare(ownerId, agent, chatId),
  registerRequest: (input) => pendingRequests.register(input)
})

/* ------------------------------------------------------------ the resolver */

const drivers: Record<AgentDriverId, AgentDriver> = {
  a2a: createA2aDriver({
    runTurn: runAgentTurn,
    resolveEndpoint: resolveEndpointIfNeeded,
    resolveAccessToken,
    fetchCard: fetchAgentCard,
    isReauthRequired: (err) => err instanceof CinnaReauthRequired,
    saveTaskState: ({ chatId, agentId, taskId, taskState }) =>
      agentSessionRepo.upsert({ chatId, agentId, contextId: null, taskId, taskState })
  }),
  acp: acpDriver,
  managed: createManagedDriver({
    prepare: (ownerId, agent, chatId) => managedAgentService.prepare(ownerId, agent, chatId),
    readiness: (agent) => managedAgentService.readiness(agent),
    registerRequest: (input) => pendingRequests.register(input)
  })
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
  const id = driverOfRow(agent)
  return id ? drivers[id] : unsupportedDriver
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

/** The same runtime gates used by the turn, before presenting the build composer. */
export async function developmentRuntimeBlocker(engine: import('../../../shared/engine').AgentEngine): Promise<{ blocker: string | null; installTool?: 'claude' | 'codex' | null }> {
  const ready = await acpLaunchers[engine]?.readiness?.({ fresh: true })
  // Only Claude is a CLI the user installs. OpenCode and Codex are fetched by
  // Cinna, so offering to install a PATH copy of either would install a tool no
  // spawned session uses — a failed managed download is retried in Settings.
  if (ready && ready.state !== 'ok') return { blocker: ready.reason ?? 'Check your default runtime in Settings.',
    installTool: ready.state === 'not_installed' && engine === 'claude' ? engine : null }
  if (engine === 'opencode') {
    try { await engineBinaryService.ensure() } catch (error) {
      return { blocker: error instanceof Error ? error.message : 'OpenCode could not be installed. Check Runtime settings.' }
    }
  }
  return { blocker: null }
}
