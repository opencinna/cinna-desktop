import { createHash } from 'node:crypto'
import type { ConductorContext } from './chatConductorService'

/** Session cwd is deliberately absent: every chat keeps its own session folder. */
export function syntheticRuntimePoolKey(userId: string, context: ConductorContext): string {
  return `chat-runtime:${createHash('sha256').update(JSON.stringify([
    userId, context.engine, context.credentialId, context.modelId,
    context.instructions, context.toolPolicy
  ])).digest('hex').slice(0, 32)}`
}

/**
 * `processPrompt` is the function prompt when the engine takes instructions as
 * process config (the driver decides), so incompatible functions cannot share
 * that process; null when instructions are session-owned.
 */
export function aiFunctionRuntimePoolKey(userId: string, engine: ConductorContext['engine'], credentialId: string | null, modelId: string | null, processPrompt: string | null): string {
  const digest = createHash('sha256').update(JSON.stringify([
    userId, engine, credentialId, modelId, processPrompt
  ])).digest('hex').slice(0, 24)
  return `ai-function:${digest}`
}
export const utilityAgentId = (poolKey: string): string => `${poolKey}:utility`
