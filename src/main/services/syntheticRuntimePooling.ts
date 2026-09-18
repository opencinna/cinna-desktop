import { createHash } from 'node:crypto'
import type { ConductorContext } from './chatConductorService'

/** Session cwd is deliberately absent: every chat keeps its own session folder. */
export function syntheticRuntimePoolKey(userId: string, context: ConductorContext): string {
  return `chat-runtime:${createHash('sha256').update(JSON.stringify([
    userId, context.engine, context.credentialId, context.modelId,
    context.instructions, context.toolPolicy
  ])).digest('hex').slice(0, 32)}`
}

export const AI_FUNCTION_INSTRUCTIONS = 'You perform one short text transformation. Follow the function instructions in the request and return only its output. Never use tools, read files, run commands, or ask questions.'
export const utilityAgentId = (poolKey: string): string => `${poolKey}:utility`
