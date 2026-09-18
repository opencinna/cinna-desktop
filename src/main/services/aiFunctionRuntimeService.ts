import type { AcpConnection, AcpProcessPool } from '../agents/drivers/acp/types'
import { newSessionParams, type AcpLaunchPlan } from '../agents/drivers/acp/acpLaunchers'

export interface AiFunctionRuntimeInput {
  userId: string
  systemPrompt: string
  userText: string
  warmOnly: boolean
  signal: AbortSignal
  maxOutputChars: number
}

export interface AiFunctionRuntimeDeps {
  pool: AcpProcessPool
  prepare(userId: string, systemPrompt: string, warmOnly: boolean): Promise<{
    poolKey: string; plan: AcpLaunchPlan; cwd: string
  }>
}

/** Fresh session per utility call; no session id is persisted or ever loaded. */
export function createAiFunctionRuntime(deps: AiFunctionRuntimeDeps): (input: AiFunctionRuntimeInput) => Promise<string> {
  return async (input) => {
    input.signal.throwIfAborted()
    const prepared = await deps.prepare(input.userId, input.systemPrompt, input.warmOnly)
    input.signal.throwIfAborted()
    const { poolKey, plan, cwd } = prepared
    const warm = input.warmOnly ? deps.pool.peek?.(poolKey, plan.spec.key) : undefined
    if (input.warmOnly && !warm) throw new Error('AI function deferred until the default runtime is warm')
    const release = deps.pool.hold(poolKey)
    let connection: AcpConnection | undefined
    let sessionId: string | undefined
    let unbind = (): void => {}
    let removeAbort = (): void => {}
    let text = ''
    try {
      connection = warm ?? await deps.pool.acquire(poolKey, plan.spec, plan.init, input.signal)
      input.signal.throwIfAborted()
      const conn = connection
      let rejectAbort: (error: unknown) => void = () => {}
      const canceled = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      const abort = (): void => {
        if (sessionId) void conn.cancel(sessionId).catch(() => {})
        rejectAbort(input.signal.reason ?? new Error('AI function canceled'))
      }
      input.signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => input.signal.removeEventListener('abort', abort)
      if (input.signal.aborted) abort()
      const work = async (): Promise<string> => {
        const created = await conn.newSession({ ...newSessionParams(plan, cwd), mcpServers: [] })
        sessionId = created.sessionId
        // Cancellation can land while session/new is pending. Its late result
        // must never start a prompt or become a remembered continuation.
        if (input.signal.aborted) {
          void conn.cancel(sessionId).catch(() => {})
          input.signal.throwIfAborted()
        }
        unbind = conn.bindSession(sessionId, {
          onUpdate: ({ update }) => {
            if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
              const chunk = text.length === 0 ? update.content.text.trimStart() : update.content.text
              text += chunk.slice(0, Math.max(0, input.maxOutputChars - text.length))
            }
          },
          onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
          onElicitation: async () => ({ action: 'cancel' })
        })
        if (plan.setup.modeId) await conn.setSessionMode({ sessionId, modeId: plan.setup.modeId })
        for (const option of plan.setup.configOptions ?? []) {
          try { await conn.setSessionConfigOption({ sessionId, configId: option.configId, value: option.value }) }
          catch (error) { if (!option.optional) throw error }
        }
        input.signal.throwIfAborted()
        const answer = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: input.userText }] })
        if (answer.stopReason !== 'end_turn' && answer.stopReason !== 'max_tokens') throw new Error(`AI function stopped: ${answer.stopReason}`)
        return text
      }
      return await Promise.race([work(), canceled, conn.exited.then(() => { throw new Error('AI function runtime exited') })])
    } finally {
      removeAbort()
      unbind()
      // ACP has no session/delete. Cancel ends work and dropping the binding
      // discards the address; this session is never loaded by another call.
      if (connection && sessionId) void connection.cancel(sessionId).catch(() => {})
      release()
    }
  }
}

export async function runAiFunctionOnRuntime(input: AiFunctionRuntimeInput): Promise<string> {
  const { acpProcessPool, prepareAiFunctionRuntime } = await import('../agents/drivers')
  return createAiFunctionRuntime({ pool: acpProcessPool, prepare: prepareAiFunctionRuntime })(input)
}
