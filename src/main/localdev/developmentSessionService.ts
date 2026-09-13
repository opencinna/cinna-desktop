import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentRepo, type AgentRow } from '../db/agents'
import { userRepo } from '../db/users'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { localDevService } from './localDevService'
import { runtimeService } from '../services/localAgents/runtimeService'
import { defaultEngineService } from '../services/localAgents/defaultEngineService'
import { appSettingsService } from '../services/appSettingsService'
import { isAgentEngine } from '../../shared/engine'
import { collectEngineConfigInput, getCachedEngineModels } from '../engine/engineConfigSource'
import { isWithin } from '../services/localAgents/pathRules'
import { DEFAULT_DEVELOPMENT_COMPLEXITY, isDevelopmentAgent, type DevelopmentContext } from '../../shared/developmentSession'
export { isDevelopmentAgent } from '../../shared/developmentSession'
import { isWorkComplexity } from '../../shared/modelFamilies'
import { cliWorkspaceRequirement } from '../../shared/cinnaCli'

const DOCUMENTS = ['CLAUDE.md', 'context/README.md', 'context/platform/README.md']

/** Only public CLI guides, never account.json, .env, or arbitrary renderer paths. */
export function readDevelopmentDocuments(root: string): DevelopmentContext['documents'] {
  const realRoot = realpathSync(root)
  return DOCUMENTS.flatMap((path) => {
    try {
      const file = realpathSync(join(realRoot, path))
      if (file !== join(realRoot, path) || !isWithin(realRoot, file) || !statSync(file).isFile() || statSync(file).size > 128_000) return []
      return [{ path, content: readFileSync(file, 'utf8') }]
    } catch { return [] }
  })
}

export function developmentContext(): DevelopmentContext {
  const profileId = getProfileScopeUserId()
  const user = userRepo.get(profileId)
  const state = localDevService.getState()
  if (!user?.cinnaServerUrl || state.phase !== 'ready') {
    throw new Error(state.phase === 'attention' ? state.detail : 'Finish local development setup before starting a build session.')
  }
  const documents = readDevelopmentDocuments(state.workspacePath)
  const settings = appSettingsService.getAll()
  const override = settings.localDevelopmentEngine
  const complexity = isWorkComplexity(settings.localDevelopmentComplexity) ? settings.localDevelopmentComplexity : DEFAULT_DEVELOPMENT_COMPLEXITY
  const credential = override === 'opencode' ? settings.localDevelopmentCredentialId : ''
  const runtime = runtimeService.resolve({
    engine: isAgentEngine(override) ? override : defaultEngineService.current(),
    complexity,
    ...(credential ? { credential } : {})
  }, undefined, getCachedEngineModels())
  if (credential && runtime.credentialId !== credential) {
    runtime.reason = 'The Local Development credential is unavailable. Choose another in Local Development Settings.'
  }
  const instructions = [
    'You are helping this user build agents in Cinna Core through cinna-cli.',
    `Target instance: ${user.cinnaServerUrl}. Account: ${user.displayName} (${user.username}).`,
    `Your working directory is the Cinna account workspace: ${state.workspacePath}.`,
    'Start by checking the account and available agents with cinna-cli. Consult the workspace context before choosing commands. Use cinna --help for the installed CLI syntax.',
    'Build and test with cinna-cli and your local tools. Check fresh remote statuses before reporting an agent created, updated, or ready. Explain the result in plain language.',
    'Never print account tokens, credential files, or secrets. Follow desktop tool approval requests.',
    ...documents.map((doc) => `\n--- ${doc.path} ---\n${doc.content}`)
  ].join('\n')
  return {
    profileId, serverUrl: user.cinnaServerUrl, accountName: user.displayName || user.username,
    workspacePath: state.workspacePath, cliVersion: state.cliVersion, runtime, complexity, documents, instructions,
    setupTarget: state.protocol === 'json' ? 'runtime' : 'local-dev',
    blocker: state.protocol !== 'json'
      ? cliWorkspaceRequirement(state.cliVersion)
      : runtime.reason
  }
}

/** Warm the same model catalogue the OpenCode launcher uses before claiming readiness. */
export async function loadDevelopmentContext(): Promise<DevelopmentContext> {
  const initial = developmentContext()
  if (initial.runtime.launcher === 'opencode') {
    await collectEngineConfigInput(getSettingsScopeUserId(), { refreshModels: false })
  }
  const current = developmentContext()
  if (current.profileId !== initial.profileId || current.workspacePath !== initial.workspacePath || current.complexity !== initial.complexity || current.runtime.launcher !== initial.runtime.launcher || current.runtime.credentialId !== initial.runtime.credentialId) {
    throw new Error('The active Cinna account or runtime changed. Check again.')
  }
  return current
}

/** The public build-page snapshot and runtime prerequisite probe are one guarded service operation. */
export async function getDevelopmentSessionContext(
  probe: (engine: DevelopmentContext['runtime']['launcher']) => Promise<Pick<DevelopmentContext, 'blocker' | 'installTool'>>,
  fresh = false
): Promise<DevelopmentContext> {
  if (fresh) {
    const profileId = getProfileScopeUserId()
    await localDevService.recheckCapabilities(profileId)
    if (getProfileScopeUserId() !== profileId) throw new Error('The active profile changed. Check again.')
  }
  const context = await loadDevelopmentContext()
  const readiness = context.blocker ? { blocker: context.blocker } : await probe(context.runtime.launcher)
  const current = developmentContext()
  if (current.profileId !== context.profileId || current.workspacePath !== context.workspacePath || current.complexity !== context.complexity || current.runtime.launcher !== context.runtime.launcher || current.runtime.credentialId !== context.runtime.credentialId || current.runtime.modelId !== context.runtime.modelId) {
    throw new Error('The active profile or runtime changed. Check again.')
  }
  return { ...current, ...readiness, blocker: current.blocker ?? readiness.blocker }
}

/** A saved conversation remains bound to its account, workspace, and runtime. */
export function contextForDevelopmentAgent(row: AgentRow): DevelopmentContext {
  const context = developmentContext()
  if (row.driverConfig?.developmentProfileId !== context.profileId || row.driverConfig.cwd !== context.workspacePath ||
      row.driverConfig.developmentEngine !== context.runtime.launcher) {
    throw new Error('The Cinna account, workspace, or build runtime changed. Start a new build session from Local Development.')
  }
  if (context.blocker) throw new Error(context.blocker)
  return context
}

/** Startup restores the account asynchronously; neither probes nor turns should cache that as a failed setup. */
export async function restoreDevelopmentContext(row: AgentRow, options: { fresh?: boolean } = {}): Promise<DevelopmentContext> {
  const profileId = getProfileScopeUserId()
  if (row.driverConfig?.developmentProfileId === profileId) {
    const phase = localDevService.getState().phase
    // Reconcile joins an existing restoration and honors the saved consent.
    // A settled failure remains actionable rather than starting a retry loop.
    if (phase === 'idle' || phase === 'installing') await localDevService.reconcile(profileId)
    if (getProfileScopeUserId() !== profileId) throw new Error('The active Cinna account changed. Check again.')
    // Chat's explicit readiness check must retry the CLI probe too; list reads
    // and ordinary turns retain the last successful capability snapshot.
    if (options.fresh && localDevService.getState().phase === 'ready') {
      await localDevService.recheckCapabilities(profileId)
      if (getProfileScopeUserId() !== profileId) throw new Error('The active Cinna account changed. Check again.')
    }
    // Resumed OpenCode chats need the same catalogue warmup as the start page.
    // Its empty process-local cache after restart is not a missing credential.
    await loadDevelopmentContext()
  }
  return contextForDevelopmentAgent(row)
}

export function developmentAgentContext(userId: string, agentId: string): DevelopmentContext | null {
  const row = agentRepo.getOwned(userId, agentId)
  return isDevelopmentAgent(row) ? contextForDevelopmentAgent(row!) : null
}

/** No workspace files or cloud agents are created here. The first message starts work. */
export async function prepareDevelopmentSession(expected: Pick<DevelopmentContext, 'profileId' | 'workspacePath' | 'serverUrl' | 'runtime' | 'complexity'>): Promise<{ agentId: string }> {
  const context = developmentContext()
  if (expected.profileId !== context.profileId || expected.workspacePath !== context.workspacePath || expected.serverUrl !== context.serverUrl) {
    throw new Error('The active Cinna instance changed. Reopen Local Development before sending.')
  }
  if (expected.complexity !== context.complexity || expected.runtime.launcher !== context.runtime.launcher || expected.runtime.credentialId !== context.runtime.credentialId || expected.runtime.modelId !== context.runtime.modelId) {
    throw new Error('The build runtime changed. Check the build workspace again before sending.')
  }
  if (context.blocker) throw new Error(context.blocker)
  await localDevService.executionContext(context.profileId)
  const current = developmentContext()
  if (current.profileId !== context.profileId || current.workspacePath !== context.workspacePath || current.complexity !== context.complexity || current.runtime.launcher !== context.runtime.launcher || current.runtime.credentialId !== context.runtime.credentialId || current.runtime.modelId !== context.runtime.modelId) {
    throw new Error('Local development changed while preparing. Try again.')
  }
  const owner = getSettingsScopeUserId()
  const existing = agentRepo.list(owner).find((row) => isDevelopmentAgent(row) && row.enabled &&
    row.driverConfig?.developmentProfileId === context.profileId && row.driverConfig.cwd === context.workspacePath &&
    row.driverConfig.developmentEngine === context.runtime.launcher)
  if (existing) return { agentId: existing.id }
  const row = agentRepo.createRuntime(owner, {
    name: `Build · ${context.accountName}`, driver: 'acp', description: `Build agents on ${context.serverUrl}`,
    config: { launcher: 'custom', command: ['cinna-development-session'], cwd: context.workspacePath,
      developmentProfileId: context.profileId, developmentEngine: context.runtime.launcher }
  })
  return { agentId: row.id }
}

export function developmentPlanKey(key: string, path: string): string {
  return createHash('sha256').update(JSON.stringify([key, path])).digest('hex')
}
