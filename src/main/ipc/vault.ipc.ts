import { ipcMain, type MessagePortMain } from 'electron'
import { ipcHandle } from './_wrap'
import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { vaultService } from '../vault/vaultService'
import { moveService } from '../vault/moveService'
import { openVaultTerminal } from '../vault/vaultTerminal'
import type {
  VaultAgentDetailsDto,
  VaultAvailabilityDto,
  VaultEngineAuthDto,
  VaultEngineChoiceDto,
  VaultFileEntryDto,
  VaultHostCopyDto,
  VaultPrecheckDto,
  VaultResult,
  VaultRuntimeDto,
  VaultSecretListDto,
  VaultStatusDto,
  VaultTerminalCommand,
  VaultTerminalEvent
} from '../../shared/vault/types'
import type { StoredPermissionGrant } from '../../shared/localAgentRequests'

/**
 * Agent Vault: transport only. Every answer is a `VaultResult` (codes as
 * data: a thrown code never reaches the renderer). Vault agents are rows of
 * the settings scope, like every local agent. The terminal is a MessagePort.
 */
export function registerVaultHandlers(): void {
  ipcHandle('vault:availability', (): Promise<VaultAvailabilityDto> => vaultService.availability())

  ipcHandle('vault:list', (): Promise<VaultResult<VaultStatusDto[]>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.refresh(getSettingsScopeUserId()))
  })

  ipcHandle('vault:status', (_event, agentId: string): Promise<VaultResult<VaultStatusDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.status(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:unlock', (_event, agentId: string): Promise<VaultResult<VaultStatusDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.unlock(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:lock', (_event, agentId: string): Promise<VaultResult<VaultStatusDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.lock(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:set-size', (_event, agentId: string, sizeBytes: number): Promise<VaultResult<VaultStatusDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.setSize(getSettingsScopeUserId(), agentId, sizeBytes))
  })

  ipcHandle('vault:set-egress', (_event, agentId: string, hosts: string[]): Promise<VaultResult<VaultStatusDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.setEgress(getSettingsScopeUserId(), agentId, hosts))
  })

  ipcHandle('vault:set-lock-timeout', (_event, agentId: string, lockAfterMs: unknown): Promise<VaultResult<VaultStatusDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.setLockTimeout(getSettingsScopeUserId(), agentId, lockAfterMs))
  })

  // Fire-and-forget from the composer's keystrokes: nothing comes back, and a
  // session that is not activated simply does not touch.
  ipcHandle('vault:touch', (_event, agentId: unknown): void => {
    if (!userActivation.isActivated() || typeof agentId !== 'string') return
    vaultService.touch(getSettingsScopeUserId(), agentId)
  })

  ipcHandle('vault:destroy', (_event, agentId: string): Promise<VaultResult<void>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.destroy(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:precheck', (_event, agentId: string): Promise<VaultResult<VaultPrecheckDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.precheck(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:move-in', (_event, agentId: string, options: unknown): Promise<VaultResult<{ moveId: string }>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.moveIn(getSettingsScopeUserId(), agentId, options))
  })

  ipcHandle('vault:cancel-move', (_event, moveId: string): Promise<VaultResult<void>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.cancelMove(moveId))
  })

  ipcHandle('vault:host-copy', (_event, agentId: string): Promise<VaultResult<VaultHostCopyDto | null>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.hostCopy(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:delete-host-copy', (_event, agentId: string, typedName: unknown): Promise<VaultResult<void>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.deleteHostCopy(getSettingsScopeUserId(), agentId, typedName))
  })

  ipcHandle('vault:move-out', (_event, agentId: string): Promise<VaultResult<{ folderPath: string }>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.moveOut(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:secrets', (_event, agentId: string): Promise<VaultResult<VaultSecretListDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.secrets(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:set-secret', (_event, agentId: string, name: unknown, value: unknown): Promise<VaultResult<void>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.setSecret(getSettingsScopeUserId(), agentId, name, value))
  })

  ipcHandle('vault:delete-secret', (_event, agentId: string, name: unknown): Promise<VaultResult<void>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.deleteSecret(getSettingsScopeUserId(), agentId, name))
  })

  // The agent page's Overview, Credentials and approvals: read from inside the vault, never a host folder.
  ipcHandle('vault:agent-details', (_event, agentId: string): Promise<VaultResult<VaultAgentDetailsDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.agentDetails(getSettingsScopeUserId(), agentId))
  })

  // The Permissions card's *Always allowed* list: a vault agent's grants are in the vault, not a host file.
  ipcHandle('vault:grants', (_event, agentId: string): Promise<VaultResult<StoredPermissionGrant[]>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.permissionGrants(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:forget-grant', (_event, agentId: string, key: unknown): Promise<VaultResult<StoredPermissionGrant[]>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.forgetPermissionGrant(getSettingsScopeUserId(), agentId, key ?? null))
  })

  ipcHandle('vault:engine-auth', (_event, agentId: string): Promise<VaultResult<VaultEngineAuthDto>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.engineAuth(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:runtimes', (_event, agentId: string): Promise<VaultResult<VaultRuntimeDto[]>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.runtimes(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:engines', (_event, agentId: string): Promise<VaultResult<VaultEngineChoiceDto[]>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.engines(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:switch-engine', (_event, agentId: string, options: unknown): Promise<VaultResult<{ moveId: string }>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.switchEngine(getSettingsScopeUserId(), agentId, options))
  })

  // The Runs with panel's model, effort and complexity (Claude, Codex, Antigravity); validated again in main.
  ipcHandle('vault:set-runs-with', (_event, agentId: string, options: unknown): Promise<VaultResult<void>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.setRunsWith(getSettingsScopeUserId(), agentId, options))
  })

  ipcHandle('vault:update-dependencies', (_event, agentId: string): Promise<VaultResult<{ moveId: string }>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.updateDependencies(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('vault:list-files', (_event, agentId: string, path: unknown): Promise<VaultResult<VaultFileEntryDto[]>> => {
    userActivation.requireActivated()
    return vaultService.result(() => vaultService.listFiles(getSettingsScopeUserId(), agentId, path))
  })

  ipcHandle('vault:export-file', (_event, agentId: string, path: unknown): Promise<VaultResult<{ savedTo: string } | null>> => {
    userActivation.requireActivated()
    return vaultService.result(() => moveService.exportFile(getSettingsScopeUserId(), agentId, path))
  })

  // Gated (the helper prompts). `ipcRenderer.postMessage` passes the agent id as
  // the second argument and the port on `event.ports` (see CLAUDE.md).
  ipcMain.on('vault:open-terminal', (event, agentId: unknown) => {
    const port = event.ports?.[0]
    if (!port) return
    openTerminalPort(port, agentId)
  })
}

/**
 * One terminal over a MessagePort: the window posts `VaultTerminalCommand`s,
 * main posts `VaultTerminalEvent`s and closes the port after the last one.
 * The port closing (the window gone) ends the session.
 */
export function openTerminalPort(port: Pick<MessagePortMain, 'start' | 'postMessage' | 'close' | 'on'>, agentId: unknown): void {
  port.start()
  let open = true
  const post = (event: VaultTerminalEvent): void => {
    if (!open) return
    port.postMessage(event)
    if (event.type === 'exit' || event.type === 'error') {
      open = false
      port.close()
    }
  }
  if (!userActivation.isActivated()) {
    post({ type: 'error', code: 'denied', message: 'Session not activated — user must authenticate first' })
    return
  }
  if (typeof agentId !== 'string' || !agentId) {
    post({ type: 'error', code: 'invalid', message: 'No agent named.' })
    return
  }
  const session = openVaultTerminal(getSettingsScopeUserId(), agentId, post)
  port.on('message', (message) => {
    const command = message.data as VaultTerminalCommand | null
    if (!open || !command || typeof command !== 'object') return
    if (command.type === 'input' && typeof command.data === 'string') session.write(command.data)
    else if (command.type === 'resize') session.resize(command.cols, command.rows)
    else if (command.type === 'close') session.close()
  })
  port.on('close', () => {
    open = false
    session.close()
  })
}
