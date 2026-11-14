/**
 * The ACP driver's view of an agent in an Agent Vault: its runtime view (the
 * guest's folder, sessions and grants kept in the vault), the vault launcher's
 * dependencies, and the driver's `vault` branch (launcher, readiness, the
 * turn's hold). Wired by `drivers/index.ts`; a module of its own so a test can
 * build a real driver on a vault agent without the rest of the app.
 */
import { agentRepo, agentSessionRepo, type AgentRow } from '../../../db/agents'
import { chatVaultId } from '../../../db/chats'
import { DEFAULT_CLAUDE_APPROVAL, isClaudeApproval } from '../../../../shared/engine'
import { vaultAgentState } from '../../../vault/vaultAgentState'
import { vaultCredentials } from '../../../vault/vaultCredentials'
import { vaultRefOf, vaultService } from '../../../vault/vaultService'
import { vaultRuntimePins } from '../../../vault/moveService'
import type { AcpDriverDeps } from './acpDriver'
import type { AcpRuntimeView } from './acpRuntime'
import { createVaultClaudeLauncher, vaultReadiness, type VaultAgentLaunchInfo, type VaultLauncherDeps } from './vaultLauncher'
import { createVaultAntigravityLauncher, createVaultCodexLauncher, createVaultOpencodeLauncher } from './vaultEngineLaunchers'

/** A vault agent row's launch facts (`driverConfig.vault`), or null for any other row. */
export function vaultLaunchInfo(row: AgentRow): VaultAgentLaunchInfo | null {
  const ref = vaultRefOf(row)
  if (!ref) return null
  const raw = (row.driverConfig?.['vault'] ?? {}) as Record<string, unknown>
  return {
    vaultId: ref.vaultId,
    engine: ref.engine,
    kind: raw['kind'] === 'bare' ? 'bare' : 'kit',
    model: typeof raw['model'] === 'string' && raw['model'] ? raw['model'] : null,
    approval: isClaudeApproval(raw['approval']) ? raw['approval'] : DEFAULT_CLAUDE_APPROVAL
  }
}

/**
 * The folder view's `kind` and `runtimeMode` for every vault agent: fixed, and
 * display-only (D34). The host row's `kind` is Cinna's data and changes
 * nothing; how the agent runs inside (sealed or native, mode, model, prompt)
 * is read by the vault launcher's plan from the vault's own `cinna.launch`,
 * and that plan never reads `ctx.folder`. Fixed to the most closed values so
 * a host consumer of the view (the kit handback note, the uploads folder)
 * never gains anything from a vault agent.
 */
const VAULT_FOLDER_VIEW = { kind: 'kit', runtimeMode: 'isolated' } as const

/**
 * A vault agent's runtime view: its folder is the guest's, its sessions and
 * grants are kept in the vault (`vaultAgentState`; the DB keeps the session
 * id as for every agent), and a turn may run only in a vault chat of that
 * same vault — anywhere else its words would land in this computer's
 * database (D23).
 */
export function vaultAcpRuntime(agent: AgentRow): AcpRuntimeView | null {
  const info = vaultLaunchInfo(agent)
  if (!info) return null
  const client = (): ReturnType<typeof vaultService.client> => vaultService.client(info.vaultId)
  return {
    type: 'folder',
    folder: {
      name: agent.name, slug: '', description: agent.description ?? '', path: vaultService.agentCwd(info.vaultId),
      kind: VAULT_FOLDER_VIEW.kind, runtimeMode: VAULT_FOLDER_VIEW.runtimeMode,
      enabled: agent.enabled, readiness: 'ok', readinessReason: null, blocksTurn: false,
      runtime: { engine: info.engine }, vault: { vaultId: info.vaultId, engine: info.engine }
    },
    validate(chatId) {
      if (chatId !== undefined && chatVaultId(chatId) !== info.vaultId) {
        throw new Error('This agent is in a vault: talk to it in a new chat of its own.')
      }
    },
    readSession: (chatId) => agentSessionRepo.getByChatAndAgent(chatId, agent.id)?.contextId ?? null,
    saveSession: (chatId, sessionId) => {
      agentSessionRepo.upsert({ chatId, agentId: agent.id, contextId: sessionId, taskId: null, taskState: null })
      vaultAgentState.saveSession(info.vaultId, client, chatId, sessionId)
    },
    isGranted: (request) => vaultAgentState.isGranted(info.vaultId, request),
    rememberGrant: (request) => vaultAgentState.rememberGrant(info.vaultId, client, request)
  }
}

export const vaultLauncherDeps: VaultLauncherDeps = {
  vaultOf: (userId, agentId) => {
    const row = agentRepo.getOwned(userId, agentId)
    return row ? vaultLaunchInfo(row) : null
  },
  stateOf: (vaultId) => vaultService.stateOf(vaultId),
  client: (vaultId) => vaultService.client(vaultId),
  agentCwd: (vaultId) => vaultService.agentCwd(vaultId),
  pins: (engine) => vaultRuntimePins(engine)
}

/** The driver's `vault` branch: Claude, Codex, OpenCode and Antigravity (on a Gemini API key). */
export function vaultDriverDeps(): NonNullable<AcpDriverDeps['vault']> {
  const launchers = {
    claude: createVaultClaudeLauncher(vaultLauncherDeps),
    codex: createVaultCodexLauncher(vaultLauncherDeps),
    opencode: createVaultOpencodeLauncher(vaultLauncherDeps),
    antigravity: createVaultAntigravityLauncher(vaultLauncherDeps)
  } as const
  return {
    launcher: (engine) => launchers[engine] ?? null,
    readiness: async (_userId, agent) => {
      const info = vaultLaunchInfo(agent)
      if (!info) return { state: 'invalid', reason: 'This agent is not in a vault.' }
      return vaultReadiness(vaultLauncherDeps, info)
    },
    hold: async (_userId, agent) => {
      const info = vaultLaunchInfo(agent)
      if (!info) throw new Error('This agent is not in a vault.')
      const release = await vaultService.hold(agent.userId, agent.id)
      try {
        const client = await vaultService.client(info.vaultId)
        await vaultAgentState.load(info.vaultId, client)
        // Service credentials whose files changed since the last delivery (never throws).
        await vaultCredentials.beforeTurn(info.vaultId, client, vaultService.agentCwd(info.vaultId))
      } catch (error) {
        await release()
        throw error
      }
      return release
    }
  }
}
