import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { parseCustomAgentConfig } from '../../../../shared/customAgents'
import type { AcpLauncher } from './acpLaunchers'
import { ACP_PROTOCOL_VERSION } from './types'
import { airClientMeta } from './acpActivity'

/**
 * Background work is reported to any custom agent that knows how. Native
 * subagent sessions are not offered: an agent that implements them would move
 * its spawn calls out of the parent's stream, and only the Claude adapter's
 * shape is routed back.
 */
const CUSTOM_CLIENT_CAPABILITIES = { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) }

export function createCustomLauncher(deps: {
  childEnv(): Promise<Record<string, string>>
  defaultLocalCwd(): string
}): AcpLauncher {
  return {
    id: 'custom',
    async plan(ctx) {
      try {
        const config = parseCustomAgentConfig(ctx.custom)
        if (config.transport === 'websocket') {
          const key = createHash('sha256').update(JSON.stringify([ctx.userId, ctx.agentId, ctx.binding, config, ctx.accessToken])).digest('hex')
          return {
            spec: { command: 'ACP WebSocket', args: [], env: {}, cwd: config.cwd, key, remote: { ...config, accessToken: ctx.accessToken } },
            init: { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: 'cinna-desktop', version: '1' }, clientCapabilities: CUSTOM_CLIENT_CAPABILITIES },
            session: { mcpServers: [] }, setup: {}
          }
        }
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
          init: { protocolVersion: ACP_PROTOCOL_VERSION, clientInfo: { name: 'cinna-desktop', version: '1' }, clientCapabilities: CUSTOM_CLIENT_CAPABILITIES },
          session: { mcpServers: [] },
          setup: {}
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'The command could not be prepared.' }
      }
    }
  }
}
