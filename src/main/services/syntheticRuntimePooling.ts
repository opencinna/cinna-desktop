import { createHash } from 'node:crypto'
import type { ConductorContext } from './chatConductorService'

/** Session cwd is deliberately absent: every chat keeps its own session folder. */
export function syntheticRuntimePoolKey(userId: string, context: ConductorContext): string {
  return `chat-runtime:${createHash('sha256').update(JSON.stringify([
    userId, context.engine, context.credentialId, context.modelId,
    context.instructions, context.toolPolicy
  ])).digest('hex').slice(0, 32)}`
}

/** OpenCode instructions are process config; incompatible functions cannot share that process. */
export function aiFunctionRuntimePoolKey(userId: string, engine: ConductorContext['engine'], credentialId: string | null, modelId: string | null, systemPrompt: string): string {
  const digest = createHash('sha256').update(JSON.stringify([
    userId, engine, credentialId, modelId, engine === 'opencode' ? systemPrompt : null
  ])).digest('hex').slice(0, 24)
  return `ai-function:${digest}`
}
export const utilityAgentId = (poolKey: string): string => `${poolKey}:utility`
