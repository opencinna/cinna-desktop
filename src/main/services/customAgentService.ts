import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import { agentRepo, agentSessionRepo, type AgentRow } from '../db/agents'
import { chatRepo } from '../db/chats'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { getShellEnv, shellEnvForChild } from '../shell/env'
import { parseCustomAgentConfig, type CustomAgentConfig, type CustomAgentTestResult } from '../../shared/customAgents'
import { isPermissionGranted, permissionGrantKey, permissionGrantPatterns, type StoredPermissionGrant } from '../../shared/localAgentRequests'
import { desktopStateService, type ExternalRuntimeStateKey } from './localAgents/desktopStateService'
import { turnLock } from './localAgents/turnLock'
import { createCustomLauncher } from '../agents/drivers/acp/customLauncher'
import { startAcpConnection } from '../agents/drivers/acp/acpConnection'
import { acpProcessPool } from '../agents/drivers/acp/acpPool'
import { isRefusal } from '../agents/drivers/acp/acpLaunchers'
import type { AcpRuntimeView } from '../agents/drivers/acp/acpRuntime'
import type { AcpConnection } from '../agents/drivers/acp/types'
import type { AgentReadiness } from '../../shared/agentDrivers'
import { agentReadinessService } from './agentReadinessService'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = (row: AgentRow): string => digest([row.source, row.driver, row.driverConfig, row.enabled])
const assertCustom = (row: AgentRow | undefined): AgentRow => {
  if (!row || row.source !== 'local' || row.driver !== 'acp' || row.driverConfig?.launcher !== 'custom') throw new Error('Command-line agent not found.')
  return row
}
const launcher = createCustomLauncher({
  defaultLocalCwd: () => app.getPath('home'),
  childEnv: async () => ({ ...shellEnvForChild(await getShellEnv()), SSH_ASKPASS_REQUIRE: 'never' })
})
interface Receipt {
  ownerId: string; profileId: string; id?: string; original: string | null
  config: CustomAgentConfig; result: CustomAgentTestResult; expires: number
}
const receipts = new Map<string, Receipt>()
const probes = new Map<string, AbortController>()
const readiness = new Map<string, AgentReadiness>()

/** Private command configuration and initialize-only probes; no credential form. */
export const customAgentService = {
  launcher,
  configuration(id: string): { name: string; config: CustomAgentConfig; grants: StoredPermissionGrant[] } {
    const ownerId = getSettingsScopeUserId()
    const row = assertCustom(agentRepo.getOwned(ownerId, id))
    const state = desktopStateService.readExternal(this.stateKey(ownerId, row))
    return { name: row.name, config: parseCustomAgentConfig(row.driverConfig), grants: Object.entries(state.permissionGrants).map(([key, value]) => ({ key, ...value })).sort((a, b) => b.decidedAt - a.decidedAt) }
  },
  stateKey(ownerId: string, row: AgentRow): ExternalRuntimeStateKey {
    return { ownerId, agentId: row.id, binding: digest([getProfileScopeUserId(), ownerId, row.id, identity(row)]) }
  },
  runtime(ownerId: string, supplied: AgentRow): AcpRuntimeView {
    const row = assertCustom(agentRepo.getOwned(ownerId, supplied.id))
    if (identity(row) !== identity(supplied)) throw new Error('This command changed. Start again with its current configuration.')
    const profileId = getProfileScopeUserId()
    const config = parseCustomAgentConfig(row.driverConfig)
    const original = identity(row)
    const key = this.stateKey(ownerId, row)
    const validate = (chatId?: string): void => {
      const current = agentRepo.getOwned(ownerId, row.id)
      if (getProfileScopeUserId() !== profileId || !current || !current.enabled || identity(current) !== original) throw new Error('This command or active profile changed. Start a new chat with the current configuration.')
      if (chatId && !chatRepo.getOwned(profileId, chatId)) throw new Error('This conversation is no longer available.')
    }
    const state = () => { validate(); return desktopStateService.readExternal(key) }
    return {
      type: 'external', name: row.name, enabled: row.enabled, config, binding: key.binding,
      validate,
      readiness: async (options) => {
        validate()
        // Routine list reads never execute a user command. Explicit Test and
        // Check again initialize it; a turn always performs its own handshake.
        if (!options?.fresh || turnLock.isLocked(row.id)) return readiness.get(key.binding) ?? null
        try { await this.test({ id: row.id, config }); return { state: 'ok', reason: null } }
        catch (error) { return { state: 'unreachable', reason: error instanceof Error ? error.message : 'The command did not answer.' } }
      },
      readSession: (chatId) => {
        validate(chatId)
        const session = state().sessions[chatId]
        if (session) return session.sessionId
        if (agentSessionRepo.getByChatAndAgent(chatId, row.id)?.contextId) throw new Error('This chat belongs to an earlier command configuration or its state is unavailable. Start a new chat.')
        return null
      },
      saveSession: (chatId, sessionId) => {
        validate(chatId)
        desktopStateService.patchExternal(key, { sessions: { ...state().sessions, [chatId]: { sessionId, updatedAt: Date.now() } } })
        // File first: a failed SQLite mirror can be repaired from this same
        // binding, while a failed file write must never create unbound reuse.
        validate(chatId)
        agentSessionRepo.upsert({ chatId, agentId: row.id, contextId: sessionId, taskId: null, taskState: null })
      },
      isGranted: (request) => isPermissionGranted(request, Object.values(state().permissionGrants)),
      rememberGrant: (request) => {
        const grants = { ...state().permissionGrants }
        for (const { pattern, scope } of permissionGrantPatterns(request)) {
          grants[permissionGrantKey(request.action, pattern)] = { action: request.action, pattern, scope, decidedAt: Date.now() }
        }
        desktopStateService.patchExternal(key, { permissionGrants: grants })
        return true
      }
    }
  },
  async test(input: { id?: string; config: CustomAgentConfig }): Promise<CustomAgentTestResult> {
    const config = parseCustomAgentConfig(input.config)
    const ownerId = getSettingsScopeUserId(), profileId = getProfileScopeUserId()
    const row = input.id ? assertCustom(agentRepo.getOwned(ownerId, input.id)) : null
    const original = row ? identity(row) : null
    const scope = JSON.stringify([ownerId, profileId, input.id ?? 'new'])
    probes.get(scope)?.abort()
    const controller = new AbortController()
    probes.set(scope, controller)
    const validate = (): void => {
      if (controller.signal.aborted || probes.get(scope) !== controller || getProfileScopeUserId() !== profileId || getSettingsScopeUserId() !== ownerId) throw new Error('This command test was superseded or the active profile changed.')
      if (input.id) {
        const current = agentRepo.getOwned(ownerId, input.id)
        if (!current || identity(current) !== original) throw new Error('This command changed while it was being tested. Reopen it and try again.')
        if (turnLock.isLocked(input.id)) throw new Error('This agent is busy right now. Test it when the current run finishes.')
      }
    }
    let connection: AcpConnection | undefined
    const guard = setInterval(() => { try { validate() } catch { controller.abort() } }, 100)
    guard.unref?.()
    try {
      validate()
      const plan = await launcher.plan({ userId: ownerId, agentId: input.id ?? 'preview', custom: config, binding: original ?? undefined })
      if (isRefusal(plan)) throw new Error(plan.error)
      validate()
      connection = await startAcpConnection(plan.spec, plan.init, { signal: controller.signal })
      validate()
      const initialized = connection.initialized
      const result: CustomAgentTestResult = {
        token: randomUUID(), name: (initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? config.command[0]).slice(0, 200),
        version: initialized.agentInfo?.version?.slice(0, 100) ?? null,
        authMethods: (initialized.authMethods ?? []).slice(0, 100).map((method) => ({ id: method.id.slice(0, 200), name: method.name.slice(0, 200), description: method.description?.slice(0, 1000) ?? null }))
      }
      await connection.dispose()
      validate()
      for (const [token, receipt] of receipts) if (receipt.expires < Date.now()) receipts.delete(token)
      if (receipts.size >= 100) receipts.delete(receipts.keys().next().value!)
      receipts.set(result.token, { ownerId, profileId, id: input.id, original, config, result, expires: Date.now() + 10 * 60_000 })
      if (row && digest(config) === digest(parseCustomAgentConfig(row.driverConfig))) readiness.set(this.stateKey(ownerId, row).binding, { state: 'ok', reason: null })
      return result
    } catch (error) {
      // A failed explicit probe supersedes an earlier successful one for the
      // same saved binding. Superseded/profile-stale probes cannot change it.
      try {
        validate()
        if (row && digest(config) === digest(parseCustomAgentConfig(row.driverConfig))) {
          readiness.set(this.stateKey(ownerId, row).binding, { state: 'unreachable', reason: error instanceof Error ? error.message : 'The command did not answer initialization.' })
        }
      } catch { /* This result no longer belongs to the active configuration. */ }
      throw error
    } finally {
      clearInterval(guard)
      await connection?.dispose()
      if (probes.get(scope) === controller) probes.delete(scope)
    }
  },
  save(input: { id?: string; name?: string; config: CustomAgentConfig; testToken: string }): { id: string } {
    const config = parseCustomAgentConfig(input.config)
    const receipt = receipts.get(input.testToken)
    const ownerId = getSettingsScopeUserId(), profileId = getProfileScopeUserId()
    if (!receipt || receipt.expires < Date.now() || receipt.ownerId !== ownerId || receipt.profileId !== profileId || receipt.id !== input.id || digest(receipt.config) !== digest(config)) throw new Error('Test this exact command configuration before saving it.')
    const name = (input.name ?? receipt.result.name).trim()
    if (!name || name.length > 200) throw new Error('Give this agent a name of up to 200 characters.')
    if (input.id) {
      if (turnLock.isLocked(input.id)) throw new Error('This agent is busy right now. Save when the current run finishes.')
      const current = assertCustom(agentRepo.getOwned(ownerId, input.id))
      if (identity(current) !== receipt.original) throw new Error('This agent changed after its test. Reopen it and test again.')
    }
    const row = input.id ? agentRepo.updateRuntime(ownerId, input.id, 'acp', { name, config: { ...config } }) : agentRepo.createRuntime(ownerId, { name, driver: 'acp', config: { ...config } })
    receipts.delete(input.testToken)
    readiness.set(this.stateKey(ownerId, row).binding, { state: 'ok', reason: null })
    agentReadinessService.forget(row.id)
    acpProcessPool.retire(row.id)
    return { id: row.id }
  },
  revokeGrant(id: string, grantKey: string): void {
    const ownerId = getSettingsScopeUserId()
    const row = assertCustom(agentRepo.getOwned(ownerId, id))
    const key = this.stateKey(ownerId, row)
    const grants = { ...desktopStateService.readExternal(key).permissionGrants }
    delete grants[grantKey]
    desktopStateService.patchExternal(key, { permissionGrants: grants })
  }
}
