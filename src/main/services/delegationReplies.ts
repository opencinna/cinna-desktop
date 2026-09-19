import type { DelegationReply } from '../../shared/delegations'
import { delegationRepo, type DelegationRow } from '../db/delegations'
import { createLogger } from '../logger/logger'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { chatAnswersToAgent } from './chatRouting'
import { createChatTurnQueue } from './handoverChatQueue'
import { delegationLifecycle } from './delegationLifecycle'
import { inboxService } from './inboxService'
import { runExecutionService, type RunScope } from './runExecutionService'
import { taskService } from './taskService'
import type { HandoverTurnOutcome } from './handoverService'

export interface DelegationRepliesDeps {
  repo: Pick<typeof delegationRepo, 'getById' | 'list' | 'update' | 'appendReply' | 'changeReply'>
  executorChat(userId: string, taskId: string): string | null
  chatAnswersToAgent(userId: string, chatId: string, agentId: string): string | null
  isActive(scope: RunScope): boolean
  isRunning(chatId: string): boolean
  start(scope: RunScope, chatId: string, content: string): {
    id: string
    accepted: Promise<unknown>
    completed: Promise<HandoverTurnOutcome>
  }
  watchTurn(scope: RunScope, rowId: string, completed: Promise<HandoverTurnOutcome>): void
  now(): number
  delay(ms: number): Promise<void>
  logger: { warn(message: string, detail?: unknown): void }
}

const ADMISSION_INTERRUPTED =
  'The app closed while this follow-up was being admitted. Check the executor conversation before sending it again.'

/** Pending work survives restart; a sending item is deliberately never replayed. */
export function createDelegationReplies(deps: DelegationRepliesDeps) {
  const queued = new Set<string>()
  const active = new Set<string>()
  const queue = createChatTurnQueue({
    isRunning: deps.isRunning,
    now: deps.now,
    delay: deps.delay,
    timings: { pollMs: 500, maxWaitMs: 30 * 60_000 }
  })

  function executor(row: DelegationRow): string {
    if (row.channel !== 'local' || !row.taskId || row.state === 'gated') {
      throw new Error('This local executor has not started. Answer its gate in the Inbox first.')
    }
    const chatId = deps.executorChat(row.userId, row.taskId)
    if (!chatId) throw new Error('This local executor has no conversation.')
    const refusal = deps.chatAnswersToAgent(row.userId, chatId, row.targetAgentId)
    if (refusal) throw new Error(refusal)
    return chatId
  }

  function warning(row: DelegationRow, detail: string): void {
    if (deps.repo.getById(row.userId, row.id)?.warning === detail) return
    deps.repo.update(row.userId, row.id, { warning: detail })
  }

  function requesterGone(row: DelegationRow): boolean {
    if (!row.originChatId || !row.originAgentId) return true
    return !!deps.chatAnswersToAgent(row.userId, row.originChatId, row.originAgentId)
  }

  function schedule(scope: RunScope, row: DelegationRow, reply: DelegationReply): void {
    if (queued.has(reply.id)) return
    let chatId: string
    try {
      chatId = executor(row)
    } catch (error) {
      warning(row, `reply_failed:${String(error)}`)
      return
    }
    queued.add(reply.id)
    queue.enqueue(chatId, {
      async send() {
        let accepted = false
        try {
          if (!deps.isActive(scope)) return
          const current = deps.repo.getById(scope.profileUserId, row.id)
          const stillPending = current?.pendingReplies.some(
            (item) => item.id === reply.id && item.state === 'pending'
          )
          if (!current || !stillPending) return
          if (executor(current) !== chatId) {
            throw new Error('The executor conversation changed before the reply was delivered.')
          }
          if (requesterGone(current)) throw new Error('The requester conversation is no longer available.')

          active.add(reply.id)
          deps.repo.changeReply(row.userId, row.id, reply.id, 'sending')
          const content = `Follow-up for delegation ${row.requesterKey}:\n\n${reply.message}`
          const handle = deps.start(scope, chatId, content)
          await handle.accepted
          accepted = true

          // Clear only after admission. A crash between these writes leaves sending,
          // which recovery marks uncertain instead of duplicating the accepted turn.
          deps.repo.update(row.userId, row.id, { state: 'running', runId: handle.id })
          deps.repo.changeReply(row.userId, row.id, reply.id, 'remove')
          deps.watchTurn(scope, row.id, handle.completed)
        } catch (error) {
          if (!accepted) deps.repo.changeReply(row.userId, row.id, reply.id, 'pending')
          warning(row, `${accepted ? 'reply_uncertain' : 'reply_failed'}:${reply.id}:${String(error)}`)
          deps.logger.warn('Could not deliver a delegated follow-up', {
            id: row.id,
            replyId: reply.id,
            error: String(error)
          })
        } finally {
          active.delete(reply.id)
          queued.delete(reply.id)
        }
      },
      onTimedOut() {
        queued.delete(reply.id)
        warning(row, `reply_timed_out:${reply.id}`)
      }
    })
  }

  return {
    enqueue(
      scope: RunScope,
      supplied: DelegationRow,
      message: string
    ): { delegationId: string; replyId: string; state: 'queued' } {
      if (!deps.isActive(scope)) throw new Error('The requesting profile is no longer active.')
      const row = deps.repo.getById(scope.profileUserId, supplied.id)
      if (!row) throw new Error('This delegation no longer belongs to this profile.')
      executor(row)
      if (!message.trim()) throw new Error('A reply must contain a message.')
      const reply = deps.repo.appendReply(row.userId, row.id, message.trim())
      schedule(scope, row, reply)
      return { delegationId: row.id, replyId: reply.id, state: 'queued' }
    },

    reconcile(scope: RunScope): void {
      if (!deps.isActive(scope)) return
      for (const row of deps.repo.list(scope.profileUserId)) {
        if (row.channel !== 'local') continue
        for (const reply of row.pendingReplies) {
          if (reply.state === 'pending') schedule(scope, row, reply)
          else if (!active.has(reply.id)) warning(row, `reply_uncertain:${reply.id}:${ADMISSION_INTERRUPTED}`)
        }
      }
    },

    idle: () => queue.idle()
  }
}

export const delegationReplies = createDelegationReplies({
  repo: delegationRepo,
  executorChat: (userId, taskId) => taskService.getById(userId, taskId).chatId,
  chatAnswersToAgent,
  isActive: (scope) => userActivation.isActivated() && getProfileScopeUserId() === scope.profileUserId,
  isRunning: (chatId) => runExecutionService.isRunning(chatId),
  start(scope, chatId, content) {
    return runExecutionService.start(
      scope,
      { chatId, content },
      {
        preserveOnRefusal: true,
        inputOrigin: 'handover',
        observe: (ctx, event) => inboxService.recordRunEvent(ctx, event)
      }
    )
  },
  watchTurn: (scope, rowId, completed) => delegationLifecycle.watchTurn(scope, rowId, completed),
  now: () => Date.now(),
  delay: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    }),
  logger: createLogger('delegation-replies')
})
