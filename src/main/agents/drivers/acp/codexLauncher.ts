import { createHash } from 'node:crypto'
import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { ClaudeApproval, CodexAuthStatus } from '../../../../shared/engine'
import type { ReadinessOptions } from '../driver'
import type { AcpLauncher } from './acpLaunchers'
import { ACP_PROTOCOL_VERSION } from './types'
import { createLogger } from '../../../logger/logger'

const logger = createLogger('codex-launcher')

export const CODEX_NOT_INSTALLED = 'Codex CLI was not found. Install it in Settings → Agents → Runtime.'
export const CODEX_NOT_LOGGED_IN = 'Codex is not logged in. Run `codex login` in a terminal, then check again.'

export interface CodexLauncherDeps {
  path(options?: ReadinessOptions): Promise<string | null>
  auth(options?: ReadinessOptions): Promise<CodexAuthStatus>
  adapterEntry(): string
  nodeRuntime(): { command: string; args: string[]; env: Record<string, string> }
  env(): Promise<Record<string, string>>
  systemPrompt(userId: string, agentId: string): string
  settings(userId: string, agentId: string): {
    model: string | null; effort: string; approval: ClaudeApproval
  }
}

/** Pinned app-server adapter, always driving the user's detected Codex executable. */
export function createCodexLauncher(deps: CodexLauncherDeps): AcpLauncher {
  const readiness = async (options?: ReadinessOptions): Promise<AgentReadiness> => {
    if (!await deps.path(options).catch(() => {
      logger.warn('Codex executable detection failed')
      return null
    })) {
      return { state: 'not_installed', reason: CODEX_NOT_INSTALLED }
    }
    const auth = await deps.auth(options).catch(() => {
      logger.warn('Codex authentication readiness check failed')
      return null
    })
    return auth?.state === 'logged_out'
      ? { state: 'not_logged_in', reason: CODEX_NOT_LOGGED_IN }
      : { state: 'ok', reason: null }
  }
  return {
    id: 'codex', readiness,
    async plan(ctx) {
      if (!ctx.folder) return { error: 'This launcher requires a local agent folder.' }
      let phase = 'readiness'
      try {
        const ready = await readiness()
        if (ready.state !== 'ok') return { error: ready.reason! }
        phase = 'executable'
        const path = await deps.path()
        if (!path) return { error: CODEX_NOT_INSTALLED }
        let adapter: string
        try { adapter = deps.adapterEntry() } catch {
          logger.error('The Codex ACP adapter is missing from this installation', { agentId: ctx.agentId })
          return { error: 'The Codex adapter is missing from this installation. Reinstall Cinna Desktop.' }
        }
        phase = 'settings'
        const settings = deps.settings(ctx.userId, ctx.agentId)
        const modeId = settings.approval === 'auto' ? 'agent' : 'read-only'
        phase = 'instructions'
        const config = {
          developer_instructions: deps.systemPrompt(ctx.userId, ctx.agentId),
          ...(settings.model ? { model: settings.model } : {}),
          model_reasoning_effort: settings.effort
        }
        phase = 'runtime'
        const runtime = deps.nodeRuntime()
        phase = 'environment'
        const env = {
          ...await deps.env(), ...runtime.env,
          CODEX_PATH: path, CODEX_CONFIG: JSON.stringify(config), INITIAL_AGENT_MODE: modeId
        }
        // A changed prompt/model/effort must replace the pooled process, including on resume.
        const key = createHash('sha256').update(JSON.stringify([
          runtime.command, runtime.args, adapter, ctx.folder.path,
          Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
        ])).digest('hex').slice(0, 32)
        return {
          spec: { command: runtime.command, args: [...runtime.args, adapter], env, cwd: ctx.folder.path, key },
          init: { protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: 'cinna-desktop', version: '1' } },
          session: { mcpServers: [] },
          // Enforce on both new and loaded sessions, before any prompt.
          setup: { modeId }
        }
      } catch {
        // Errors from CLI/config readers can contain credentials or instructions.
        logger.warn('Codex could not be prepared', { agentId: ctx.agentId, phase })
        return { error: 'Codex could not be prepared. Check the agent folder and Codex CLI installation.' }
      }
    }
  }
}
