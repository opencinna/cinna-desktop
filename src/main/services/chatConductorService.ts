import { runtimeHost } from '../host/runtimeHost'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { agentRepo, agentSessionRepo, type AgentRow } from '../db/agents'
import { chatRepo, type ChatRow } from '../db/chats'
import { chatModeService } from './chatModeService'
import type { ChatModeRow } from '../db/chatModes'
import { defaultEngineService } from './localAgents/defaultEngineService'
import { runtimeService } from './localAgents/runtimeService'
import { providerService, type ProviderDto } from './providerService'
import { getCachedEngineModels } from '../engine/engineConfigSource'
import { firstActiveCredential } from '../../shared/credentials'
import { llmProviderRepo } from '../db/llmProviders'
import { ChatError } from '../errors'
import { DEFAULT_USER_ID } from '../../shared/userIds'
import { isAgentEngine, type AgentEngine, type ResolvedRuntime } from '../../shared/engine'
import type { ChatToolPolicy } from '../../shared/chatModeRuntime'
import { isWorkComplexity, type WorkComplexity } from '../../shared/modelFamilies'
import type { AcpRuntimeView } from '../agents/drivers/acp/acpRuntime'
import { desktopStateService, type ExternalRuntimeStateKey } from './localAgents/desktopStateService'
import { isPermissionGranted, permissionGrantKey, permissionGrantPatterns } from '../../shared/localAgentRequests'
import { releaseChatSessions } from './chatSessionRelease'

export function isChatConductor(agent: Pick<AgentRow, 'driverConfig'>): boolean {
  return typeof agent.driverConfig?.conductorChatId === 'string'
}

export function canConduct(agent: Pick<AgentRow, 'driver' | 'driverConfig'>): boolean {
  return agent.driver === 'acp' && agent.driverConfig?.transport !== 'websocket'
}

export interface ConductorContext {
  engine: AgentEngine
  modelId: string | null
  credentialId: string | null
  instructions: string
  path: string
  toolPolicy: ChatToolPolicy
  /** The mode's Effort when the chat was set up; null is no preference. */
  complexity: WorkComplexity | null
}

/** The name a chat's runtime row carries, per engine. */
const CONDUCTOR_NAMES: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' }

const PLAIN_PROMPT = 'You are a helpful conversational assistant. Answer the user in this chat. Use the connected tools when useful. You have no access to files, shell commands, or coding tools. When a specialist is waiting for an Inbox answer, stop calling it and tell the user. A later message will identify the tool call its result completes.'

/** The default instructions of a `workspace` mode: PLAIN_PROMPT, with the chat's folder in place of "no files". */
export const WORKSPACE_PROMPT = 'You are a helpful assistant. Answer the user in this chat. You work in this chat\'s own folder, which is your current directory: you may read and write files there and run commands, and each such action is subject to the user\'s approval. Use the connected tools when useful. When a specialist is waiting for an Inbox answer, stop calling it and tell the user. A later message will identify the tool call its result completes.'

/** The instructions files a non-workspace runtime folder carries; a workspace folder holds the user's work alone. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md']

/**
 * Removes the instructions files from a workspace chat's folder root. A model
 * with write access there could leave an `AGENTS.md` that the next session
 * would load as instructions (Codex and OpenCode read it from the cwd), so this
 * runs before every workspace session (`acpLauncherFor`), and in `ensure`.
 */
export function clearWorkspaceInstructionFiles(path: string): void {
  for (const name of INSTRUCTION_FILES) rmSync(join(path, name), { force: true })
}

/**
 * Where a chat runtime's *Always allow* grants live: keyed by the runtime row
 * and its chat, never user-global, and deleted with the row
 * ({@link chatConductorService.remove}).
 */
export function conductorGrantKey(userId: string, agent: Pick<AgentRow, 'id' | 'driverConfig'>): ExternalRuntimeStateKey {
  return { ownerId: userId, agentId: agent.id, binding: `chat-runtime:${String(agent.driverConfig?.conductorChatId)}` }
}

/** Runtime choices are captured per chat; changing the default never changes an existing session. */
export function conductorContext(agent: AgentRow): ConductorContext {
  const config = agent.driverConfig
  if (!isChatConductor(agent) || !isAgentEngine(config?.conductorEngine) || typeof config?.cwd !== 'string') {
    throw new Error('This chat runtime is no longer available.')
  }
  return {
    engine: config.conductorEngine,
    modelId: typeof config.conductorModel === 'string' ? config.conductorModel : null,
    credentialId: typeof config.conductorCredential === 'string' ? config.conductorCredential : null,
    instructions: typeof config.conductorPrompt === 'string' ? config.conductorPrompt : PLAIN_PROMPT,
    path: config.cwd,
    toolPolicy: config.conductorToolPolicy === 'none' || config.conductorToolPolicy === 'workspace' ? config.conductorToolPolicy : 'connectors',
    complexity: isWorkComplexity(config.conductorComplexity) ? config.conductorComplexity : null
  }
}

/** Whether a mode and credential belong to this computer rather than an account. */
function runsOnLocalSettings(mode: Pick<ChatModeRow, 'managed' | 'userId'> | null, providerId: string | null | undefined): boolean {
  if (mode && (mode.managed || mode.userId !== DEFAULT_USER_ID)) return false
  if (!providerId) return true
  const provider = llmProviderRepo.getOwned(DEFAULT_USER_ID, providerId)
  return !!provider && !provider.managed
}

/**
 * A chat runtime's credential and model, through `runtimeService.resolve` with
 * the model catalogue (`models`), as a folder agent's are — without it a mode's
 * Effort cannot pick an OpenCode model.
 *
 * An OpenCode runtime whose chat and mode name no credential takes the machine
 * credential override, else the effective default chat mode's credential (both
 * `resolveDefault`'s), else the first credential that can run
 * (`firstActiveCredential` — the rule that made its runtime mode Ready). The
 * third step is here and not in `resolveDefault`: when the starred mode is this
 * runtime mode, the default it reads is the mode itself, with no credential.
 * `localOnly` (a chat shared across profiles) never picks an account's.
 *
 * An OpenCode model the catalogue cannot answer (empty, or no model in the
 * tier) is the credential's own default model, so a credential with one never
 * launches a chat with no model.
 */
function resolveConductorRuntime(
  engine: AgentEngine,
  providerId: string | null,
  modelId: string | null,
  complexity: WorkComplexity | null,
  providers: ProviderDto[],
  models: readonly { id: string; providerId: string }[],
  localOnly = false
): ResolvedRuntime {
  // OpenCode is the one engine that runs on an AI credential.
  const credentialed = engine === 'opencode'
  const resolveOn = (credential: string | null): ResolvedRuntime => runtimeService.resolve({
    engine,
    ...(credentialed && credential ? { credential } : {}),
    ...(modelId ? { model: modelId } : {}),
    ...(complexity ? { complexity } : {})
  }, providers, models)
  let runtime = resolveOn(providerId)
  if (!credentialed) return runtime
  if (!providerId && !runtime.credentialId) {
    const first = firstActiveCredential(localOnly ? providers.filter((provider) => !provider.managed) : providers)
    if (first) runtime = resolveOn(first.id)
  }
  if (!runtime.modelId && runtime.credentialId) {
    const own = providers.find((provider) => provider.id === runtime.credentialId)?.defaultModelId
    if (own) runtime = { ...runtime, modelId: own }
  }
  return runtime
}

/**
 * The model an OpenCode chat runtime runs on, resolved again from its captured
 * credential and Effort when it captured none. `ensure` runs before the engine
 * has listed any model (a first chat on a fresh start, an Ollama catalogue), so
 * the engine config — built after a model refresh — asks once more.
 */
export function conductorModelId(context: ConductorContext, models: readonly { id: string; providerId: string }[]): string | null {
  // Only an OpenCode runtime captures a credential.
  if (context.modelId || !context.credentialId) return context.modelId
  return resolveConductorRuntime(context.engine, context.credentialId, null, context.complexity, providerService.listMerged(), models).modelId
}

/** The folder a chat's runtime works in; created by {@link chatConductorService.ensure}. */
function conductorFolder(chatId: string): string {
  return join(runtimeHost.getPath('userData'), 'chat-conductors', chatId)
}

/**
 * A chat runtime's grant store. Workspace only: its native asks are remembered
 * per chat. Every other policy asks about Cinna's own tools alone, and nothing
 * of those is remembered.
 */
function grantsFor(userId: string, agent: AgentRow, policy: ChatToolPolicy): Pick<AcpRuntimeView, 'isGranted' | 'rememberGrant' | 'rememberScope'> {
  if (policy !== 'workspace') return { isGranted: () => false, rememberGrant: () => false }
  const key = conductorGrantKey(userId, agent)
  return {
    isGranted: (request) => isPermissionGranted(request, Object.values(desktopStateService.readExternal(key).permissionGrants)),
    rememberGrant: (request) => {
      const grants = { ...desktopStateService.readExternal(key).permissionGrants }
      for (const { pattern, scope } of permissionGrantPatterns(request)) {
        grants[permissionGrantKey(request.action, pattern)] = { action: request.action, pattern, scope, decidedAt: Date.now() }
      }
      desktopStateService.patchExternal(key, { permissionGrants: grants })
      return true
    },
    rememberScope: 'chat'
  }
}

export const chatConductorService = {
  /**
   * Open a chat's runtime folder in the host's file manager. Creates nothing:
   * a chat whose runtime never started has no folder, and says so. The caller
   * has already checked that the chat is the user's.
   */
  async openFolder(chatId: string): Promise<{ success: true } | { success: false; error: string }> {
    const path = conductorFolder(chatId)
    if (!existsSync(path)) return { success: false, error: 'This chat has no folder yet.' }
    const failure = await runtimeHost.shell.openPath(path)
    return failure ? { success: false, error: `Could not open the chat folder: ${failure}` } : { success: true }
  },

  remove(userId: string, chatId: string): void {
    // Only generated rows own these folders. User-added local agents are never
    // removed as a side effect of deleting a conversation.
    for (const agent of agentRepo.list(userId)) if (agent.driverConfig?.conductorChatId === chatId) {
      rmSync(conductorFolder(chatId), { recursive: true, force: true })
      desktopStateService.removeExternal(conductorGrantKey(userId, agent))
      agentRepo.delete(userId, agent.id)
    }
  },
  ensure(userId: string, chat: ChatRow, refresh = false): AgentRow {
    if (!refresh && chat.agentId) {
      const existing = agentRepo.getOwned(userId, chat.agentId)
      if (existing && isChatConductor(existing) && existing.driverConfig?.conductorChatId === chat.id) return existing
    }
    const existing = agentRepo.list(userId).find((agent) => agent.driverConfig?.conductorChatId === chat.id)
    if (existing && !refresh) return existing
    const mode = chat.modeId ? chatModeService.findMerged(chat.modeId) : chatModeService.resolveEffectiveDefault()
    // A chat the default profile owns is listed in every profile, so its
    // runtime must not carry one account's mode or credential.
    if (userId === DEFAULT_USER_ID && !runsOnLocalSettings(mode, chat.providerId ?? mode?.providerId)) {
      throw new ChatError('not_configured', 'This chat is shared across profiles, so it can only run on a local chat mode and credential, not your account\'s.')
    }
    const engine = isAgentEngine(mode?.engine) ? mode.engine : defaultEngineService.current()
    const providerId = chat.providerId ?? mode?.providerId
    const modelId = chat.modelId ?? mode?.modelId
    // A model override wins over the tier in `resolve`; the tier still sets Codex's effort.
    const complexity = isWorkComplexity(mode?.complexity) ? mode.complexity : null
    const runtime = resolveConductorRuntime(engine, providerId ?? null, modelId ?? null, complexity, providerService.listMerged(), getCachedEngineModels(), userId === DEFAULT_USER_ID)
    const path = conductorFolder(chat.id)
    const toolPolicy: ChatToolPolicy = mode?.toolPolicy ?? 'connectors'
    const instructions = mode?.systemPrompt?.trim() || (toolPolicy === 'workspace' ? WORKSPACE_PROMPT : PLAIN_PROMPT)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    // A workspace session can edit its folder, so its instructions never sit
    // there: a model must not rewrite its own prompt silently. They travel on
    // each engine's own prompt channel instead (Claude's systemPrompt, Codex's
    // per-session developer instructions, Antigravity's opening block,
    // OpenCode's generated agent entry).
    if (toolPolicy === 'workspace') clearWorkspaceInstructionFiles(path)
    else for (const name of INSTRUCTION_FILES) writeFileSync(join(path, name), `${instructions}\n`, { mode: 0o600 })
    const input = {
      name: CONDUCTOR_NAMES[engine],
      description: 'Chat runtime', driver: 'acp' as const,
      config: { launcher: engine, cwd: path, conductorChatId: chat.id, conductorEngine: engine,
        conductorModel: runtime.modelId, conductorCredential: runtime.credentialId,
        conductorPrompt: instructions, conductorToolPolicy: toolPolicy,
        conductorComplexity: complexity }
    }
    return existing ? agentRepo.updateRuntime(userId, existing.id, 'acp', input) : agentRepo.createRuntime(userId, input)
  },

  /**
   * A chat's runtime captures its mode's choices when the chat is set up, with
   * one exception: Tools. When the mode's tool policy (or the effective
   * default's, for a chat with no mode) no longer matches the one the chat's
   * runtime row captured, the row is refreshed and the chat's sessions released,
   * as picking the mode again would. Called at the start of a turn, so a chat
   * mid-turn during the edit picks it up on its next turn. True when it
   * refreshed.
   */
  syncToolPolicy(userId: string, chat: ChatRow): boolean {
    if (!chat.agentId) return false
    const agent = agentRepo.getOwned(userId, chat.agentId)
    if (!agent || !isChatConductor(agent) || agent.driverConfig?.conductorChatId !== chat.id) return false
    let captured: ChatToolPolicy
    try { captured = conductorContext(agent).toolPolicy } catch { return false }
    const mode = chat.modeId ? chatModeService.findMerged(chat.modeId) : chatModeService.resolveEffectiveDefault()
    if ((mode?.toolPolicy ?? 'connectors') === captured) return false
    this.ensure(userId, chat, true)
    releaseChatSessions(chat.id, agent.id)
    return true
  },

  /**
   * Whether the chat's own runtime row captured the workspace policy: what the
   * chat runs on now, not what its mode says (a Tools edit applies at the next
   * turn, {@link syncToolPolicy}). False for a chat an agent answers.
   */
  hasWorkspace(chat: Pick<ChatRow, 'id' | 'userId' | 'agentId'>): boolean {
    if (!chat.agentId) return false
    const agent = agentRepo.getOwned(chat.userId, chat.agentId)
    if (!agent || !isChatConductor(agent) || agent.driverConfig?.conductorChatId !== chat.id) return false
    try { return conductorContext(agent).toolPolicy === 'workspace' } catch { return false }
  },

  bind(userId: string, chat: ChatRow): ChatRow {
    const agent = this.ensure(userId, chat)
    chatRepo.updateMeta(userId, chat.id, { agentId: agent.id })
    return { ...chat, agentId: agent.id }
  },

  runtime(userId: string, agent: AgentRow): AcpRuntimeView {
    const context = conductorContext(agent)
    const validate = (chatId?: string): void => {
      const owner = chatRepo.getOwned(userId, String(agent.driverConfig?.conductorChatId))
      if (!owner || owner.deletedAt || (chatId && owner.id !== chatId)) throw new Error('This chat runtime is no longer available.')
    }
    validate()
    return {
      type: 'folder',
      folder: { name: agent.name, slug: `chat-${agent.id}`, description: 'Chat runtime', path: context.path,
        kind: 'bare', runtimeMode: 'isolated', enabled: agent.enabled, readiness: 'ok', readinessReason: null, blocksTurn: false,
        runtime: { engine: context.engine } },
      validate,
      readSession: (chatId) => agentSessionRepo.getByChatAndAgent(chatId, agent.id)?.contextId ?? null,
      saveSession: (chatId, sessionId) => { agentSessionRepo.upsert({ chatId, agentId: agent.id, contextId: sessionId, taskId: null, taskState: null }) },
      ...grantsFor(userId, agent, context.toolPolicy)
    }
  }
}
