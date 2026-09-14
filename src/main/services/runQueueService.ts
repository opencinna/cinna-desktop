import { nanoid } from 'nanoid'
import { runExecutionService, type RunHandle, type RunOutcome, type RunScope } from './runExecutionService'
import { activeRunsByChat } from './runExecutionState'
import { taskRunnersByChat } from './taskRunnerState'
import { handingOffChats } from './taskOperationState'
import { installTaskRunnerHooks } from './taskRunnerBridge'
import { taskHandoffRepo } from '../db/taskHandoffs'
import { chatRepo } from '../db/chats'
import { createLogger } from '../logger/logger'
import type { RunQueueItem, RunQueueView, RunSendPayload, RunStartResult } from '../../shared/ipcPayloads'

const logger = createLogger('run-queue')

type StartOptions = Parameters<typeof runExecutionService.start>[2]
/**
 * The options a start from this queue runs with, built for the payload that is
 * actually sent. A drain sends several messages as one, and the Inbox resume
 * must see that text rather than the first message's. Throwing refuses the
 * start: a drain then holds its items instead of losing them.
 */
export type QueueStartOptions = (payload: RunSendPayload) => StartOptions

/** Told the chat and its queue as it now stands, after every change. */
export type QueueListener = (chatId: string, view: RunQueueView) => void

/** A queued message, with the agent resolved to answer it when it was queued (main-only). */
interface QueuedEntry extends RunQueueItem {
  addressedAgentId: string | null
}

interface ChatQueue {
  chatId: string
  items: QueuedEntry[]
  /** A turn ended without finishing; nothing is sent until the user takes the items back. */
  held: boolean
  scope: RunScope
  options: QueueStartOptions
}

/** Stops that must not carry the next message along with them. */
const HOLDING_STATES: ReadonlySet<RunOutcome['state']> = new Set(['canceled', 'failed', 'budget'])

export const RUN_QUEUE_ATTACHMENTS_REFUSAL = 'Files can be sent once the current turn finishes.'

function viewOf(queue: ChatQueue | undefined): RunQueueView {
  return {
    items: (queue?.items ?? []).map(({ id, content, createdAt }) => ({ id, content, createdAt })),
    held: !!queue?.held
  }
}

/**
 * Messages a user sent while a turn was running, per chat.
 *
 * Main owns them for the same reason it owns the turn: the view that sent one
 * may be gone by the time the turn ends. Process-local by design — a queued
 * message is a moment's intent, and a restart that replayed it into a chat the
 * user has since moved on from would be worse than losing it.
 */
export function createRunQueueService() {
  const queues = new Map<string, ChatQueue>()
  const watched = new WeakSet<RunHandle>()
  const listeners = new Set<QueueListener>()
  const keyOf = (userId: string, chatId: string): string => JSON.stringify([userId, chatId])

  const announce = (key: string): void => {
    const [, chatId] = JSON.parse(key) as [string, string]
    const view = viewOf(queues.get(key))
    for (const listener of listeners) {
      try { listener(chatId, view) } catch (error) {
        logger.warn('a queue listener failed', { chatId, error: String(error) })
      }
    }
  }

  const forget = (key: string, queue: ChatQueue): void => {
    if (!queue.items.length && queues.get(key) === queue) queues.delete(key)
  }

  /**
   * Send what is queued once nothing is running in the chat: the leading run
   * of messages for the same agent, as one message. Messages for someone else
   * wait for that turn to end, so each goes to the agent it was addressed to.
   */
  const settle = (key: string): void => {
    const queue = queues.get(key)
    if (!queue || !queue.items.length || queue.held) return
    const active = activeRunsByChat.get(queue.chatId)
    if (active) {
      watch(key, active)
      return
    }
    const address = queue.items[0].addressedAgentId
    let count = 1
    while (count < queue.items.length && queue.items[count].addressedAgentId === address) count++
    const items = queue.items.splice(0, count)
    const payload: RunSendPayload = {
      chatId: queue.chatId,
      content: items.map((item) => item.content).join('\n\n'),
      addressedAgentId: address
    }
    // Announced **before** the start, whose user row reaches the renderer on
    // its own channel: a view that learns the row landed before it learns the
    // message left the queue shows the message twice.
    forget(key, queue)
    announce(key)
    try {
      const handle = runExecutionService.start(queue.scope, payload, queue.options(payload))
      if (queue.items.length) watch(key, handle)
    } catch (error) {
      // Back where they were, and held: the user sees them in the composer
      // rather than a queue that silently never sends.
      queue.items.unshift(...items)
      queue.held = true
      queues.set(key, queue)
      logger.warn('queued messages could not be sent', { chatId: queue.chatId, count: items.length, error: String(error) })
      announce(key)
    }
  }

  const ended = (key: string, outcome: RunOutcome): void => {
    const queue = queues.get(key)
    if (!queue || !queue.items.length) return
    if (HOLDING_STATES.has(outcome.state)) {
      if (!queue.held) {
        queue.held = true
        announce(key)
      }
      return
    }
    settle(key)
  }

  const watch = (key: string, handle: RunHandle): void => {
    if (watched.has(handle)) return
    watched.add(handle)
    // `completed` never rejects, and resolves after the run has left `activeRunsByChat`.
    void handle.completed.then((outcome) => ended(key, outcome))
  }

  return {
    /**
     * Start a turn, or hand the message to the one already running.
     *
     * A chat a task runner owns, or one with a handoff pending, is never queued
     * into: `start` refuses it in its own words. A message goes into the
     * running turn only when that turn's agent is the one it would go to, and
     * only when nothing is already queued ahead of it.
     */
    async submit(scope: RunScope, payload: RunSendPayload, options: QueueStartOptions): Promise<RunStartResult> {
      const { chatId } = payload
      const active = activeRunsByChat.get(chatId)
      if (!active || taskRunnersByChat.has(chatId) || handingOffChats.has(chatId) ||
        taskHandoffRepo.unresolvedForChat(scope.profileUserId, chatId)) {
        return { kind: 'started', runId: runExecutionService.start(scope, payload, options(payload)).id }
      }
      const chat = chatRepo.getOwned(scope.profileUserId, chatId)
      if (!chat) throw new Error('Chat not found')
      if (payload.attachments?.length) throw new Error(RUN_QUEUE_ATTACHMENTS_REFUSAL)
      if (!payload.content.trim()) throw new Error('Type a message to send while the turn runs.')

      const key = keyOf(scope.profileUserId, chatId)
      const target = runExecutionService.answererOf(chat, payload)
      const forRunningTurn = target.kind === 'agent' && !!active.agentId && target.agentId === active.agentId
      if (forRunningTurn && !queues.get(key)?.items.length) {
        let delivered: Awaited<ReturnType<RunHandle['steer']>> = 'unavailable'
        try { delivered = await active.steer(payload.content) } catch (error) {
          logger.warn('a steer failed; queueing instead', { chatId, error: String(error) })
        }
        if (delivered === 'injected') return { kind: 'injected' }
        // Saved as a row of its own once the turn had ended: a view that has
        // already read the chat must read it again to show the message.
        if (delivered === 'saved') return { kind: 'injected', saved: true }
      }

      const queue = queues.get(key) ?? { chatId, items: [], held: false, scope, options }
      queues.set(key, queue)
      queue.scope = scope
      queue.options = options
      const item: QueuedEntry = {
        id: nanoid(),
        content: payload.content,
        createdAt: Date.now(),
        // Who answers is settled now, not at the drain: an unaddressed message
        // follows the last addressed one, and by the time it drains that can be
        // a message queued after it.
        addressedAgentId: target.kind === 'agent' ? target.agentId : payload.addressedAgentId ?? null
      }
      queue.items.push(item)
      announce(key)
      // The turn may have ended while the steer was being asked.
      settle(key)
      return { kind: 'queued', queuedId: item.id }
    },

    list(scope: RunScope, chatId: string): RunQueueView {
      return viewOf(queues.get(keyOf(scope.profileUserId, chatId)))
    },

    /** Every queued message's text, in order; the queue is empty afterwards. */
    take(scope: RunScope, chatId: string): string[] {
      const key = keyOf(scope.profileUserId, chatId)
      const queue = queues.get(key)
      if (!queue) return []
      queues.delete(key)
      if (queue.items.length) announce(key)
      return queue.items.map((item) => item.content)
    },

    remove(scope: RunScope, chatId: string, id: string): boolean {
      const key = keyOf(scope.profileUserId, chatId)
      const queue = queues.get(key)
      const index = queue?.items.findIndex((item) => item.id === id) ?? -1
      if (!queue || index < 0) return false
      queue.items.splice(index, 1)
      forget(key, queue)
      announce(key)
      return true
    },

    /**
     * Replace a queued message's text. False when it is no longer queued (sent,
     * removed or taken back); empty text is refused.
     */
    edit(scope: RunScope, chatId: string, id: string, content: string): boolean {
      if (typeof content !== 'string' || !content.trim()) throw new Error('A queued message cannot be empty.')
      const key = keyOf(scope.profileUserId, chatId)
      const item = queues.get(key)?.items.find((entry) => entry.id === id)
      if (!item) return false
      item.content = content
      announce(key)
      return true
    },

    /** Drop a chat's queue — the chat is gone. */
    clear(profileUserId: string, chatId: string): void {
      const key = keyOf(profileUserId, chatId)
      if (queues.delete(key)) announce(key)
    },

    /** Drop every queue a profile holds — the profile is gone. */
    clearProfile(profileUserId: string): void {
      const prefix = JSON.stringify([profileUserId]).slice(0, -1) + ','
      for (const key of [...queues.keys()]) {
        if (!key.startsWith(prefix)) continue
        queues.delete(key)
        announce(key)
      }
    },

    onChange(listener: QueueListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}

export const runQueueService = createRunQueueService()

// A deleted chat (moved to the trash or removed for good) or profile takes its
// queue with it. Delete refuses a chat with a turn running, so what is left
// then is a held queue nobody can reach any more.
installTaskRunnerHooks({
  answer: () => null,
  taskChanged: () => {},
  chatRemoved: (userId, chatId) => runQueueService.clear(userId, chatId),
  profileRemoved: (userId) => runQueueService.clearProfile(userId)
}, 'run-queue')
