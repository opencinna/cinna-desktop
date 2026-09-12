import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { parseCustomAgentConfig } from '../../../../shared/customAgents'
import type { AcpLauncher } from './acpLaunchers'
import { ACP_PROTOCOL_VERSION } from './types'

export function createCustomLauncher(deps: {
  childEnv(): Promise<Record<string, string>>
  defaultLocalCwd(): string
}): AcpLauncher {
  return {
    id: 'custom',
    async plan(ctx) {
      try {
        const config = parseCustomAgentConfig(ctx.custom)
        const cwd = config.localCwd ?? deps.defaultLocalCwd()
        if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) return { error: 'The local process directory is not an existing absolute directory.' }
        const env = await deps.childEnv()
        const command = config.command[0]
        const args = config.command.slice(1)
        const key = createHash('sha256').update(JSON.stringify([
          ctx.userId, ctx.agentId, ctx.binding, config, cwd, Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
        ])).digest('hex')
        return {
          spec: { command, args, env, cwd, key },
          init: { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: 'cinna-desktop', version: '1' }, clientCapabilities: { elicitation: { form: {} } } },
          session: { mcpServers: [] },
          setup: {}
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'The command could not be prepared.' }
      }
    }
  }
}
