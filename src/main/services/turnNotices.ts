import { visibleChat } from '../auth/chatScope'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { agentRepo } from '../db/agents'
import { taskRepo } from '../db/tasks'
import { createLogger } from '../logger/logger'
import type { ChatOrigin } from '../../shared/chatOrigin'
import type { ChatRunResultStatus } from '../../shared/chatRunResult'

const logger = createLogger('turn-notices')

/**
 * Where a recorded turn result comes from: the live run's close, a follow-up
 * turn an agent opened on its own, or the boot pass for a turn the app was
 * killed under. Only `recovery` is never announced — a relaunch must not
 * produce a burst of notices for turns that ended before it.
 */
export type TurnRecordSource = 'live' | 'follow-up' | 'recovery'

/**
 * A chat's turn settled. Data only — no message text — for whichever host
 * shows it; the desktop turns it into an OS notification when no Cinna
 * window is focused (`host/desktop/notificationService.ts`).
 */
export interface TurnSettledNotice {
  chatId: string
  runId: string
  status: ChatRunResultStatus
  /** The core's answer to "is this a stop the user cares about" — see {@link shouldNotify}. */
  notify: boolean
  title: string
  /** The chat's bound agent, when it has one. */
  agentName: string | null
}

/**
 * A chat's **current** result was marked read: whatever the host showed for
 * the chat is about this run or an older one, and stale either way.
 */
export interface TurnResultRead {
  chatId: string
  runId: string
}

const NOTIFYING: ReadonlySet<ChatRunResultStatus> = new Set(['completed', 'needs_input', 'failed'])

/**
 * The rule, without the database: a stop the user did not cause (never
 * `canceled`, which is their own Stop) in a chat that is theirs — one they
 * opened, or the chat of a task they started themselves. A task's, job's,
 * delegation's or handover's chat is not, however it is reached.
 */
export function shouldNotify(input: {
  status: ChatRunResultStatus
  origin: ChatOrigin
  taskStartedByUser: boolean
}): boolean {
  if (!NOTIFYING.has(input.status)) return false
  return input.origin === 'user' || input.taskStartedByUser
}

/**
 * The notice for a recorded result, read in the active profile's scope. A
 * chat the profile cannot see (another profile's, or gone) or one in the
 * trash is never announced.
 */
export function turnNoticeFor(chatId: string, runId: string, status: ChatRunResultStatus): TurnSettledNotice {
  const profileUserId = getProfileScopeUserId()
  const chat = visibleChat(profileUserId, chatId)
  if (!chat || chat.deletedAt) return { chatId, runId, status, notify: false, title: '', agentName: null }
  const task = taskRepo.getByChatId(profileUserId, chatId)
  const agent = chat.agentId
    ? agentRepo.getOwned(getSettingsScopeUserId(), chat.agentId) ?? agentRepo.getOwned(profileUserId, chat.agentId)
    : undefined
  return {
    chatId,
    runId,
    status,
    notify: shouldNotify({ status, origin: chat.origin, taskStartedByUser: task?.startedByUser === true }),
    title: chat.title,
    agentName: agent?.name ?? null
  }
}

type Listener<T> = (payload: T) => void

const settledListeners = new Set<Listener<TurnSettledNotice>>()
const readListeners = new Set<Listener<TurnResultRead>>()

function emit<T>(listeners: Set<Listener<T>>, payload: T, what: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(payload)
    } catch (error) {
      logger.warn(`a ${what} listener failed`, { error: String(error) })
    }
  }
}

/**
 * The core's seam for hosts that react to a chat's turn ending — the desktop's
 * OS notifications today. Listeners are installed by the composition root
 * (`index.ts`); core never imports a host. With none installed (the plain-Node
 * hub, unit tests) nothing is read and nothing is sent.
 */
export const turnNotices = {
  onSettled(listener: Listener<TurnSettledNotice>): () => void {
    settledListeners.add(listener)
    return () => { settledListeners.delete(listener) }
  },

  onResultRead(listener: Listener<TurnResultRead>): () => void {
    readListeners.add(listener)
    return () => { readListeners.delete(listener) }
  },

  /** Called by `recordTurnResult` after the sidebar result is written. */
  settled(chatId: string, runId: string, status: ChatRunResultStatus, source: TurnRecordSource): void {
    if (source === 'recovery' || settledListeners.size === 0) return
    let notice: TurnSettledNotice
    try {
      notice = turnNoticeFor(chatId, runId, status)
    } catch (error) {
      logger.warn('could not read a settled turn for its notice', { chatId, error: String(error) })
      return
    }
    emit(settledListeners, notice, 'turn-settled')
  },

  /**
   * The chat's current result is seen (`chatService.markResultRead`, a job
   * page's latest run). Callers fire it only when the read matched the current
   * result row, never for an older run a stale view names.
   */
  resultRead(chatId: string, runId: string): void {
    emit(readListeners, { chatId, runId }, 'result-read')
  }
}
