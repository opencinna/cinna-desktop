import type {
  SessionActivityChange,
  SessionActivityItem,
  SessionActivityKind,
  SessionActivitySnapshot,
  SessionActivityTerminalState
} from '../../shared/sessionActivity'
import { createLogger } from '../logger/logger'

const logger = createLogger('session-activity')

/** Ended items kept per kind in a chat. */
export const ENDED_PER_KIND = 5

export type SessionActivityListener = (chatId: string, snapshot: SessionActivitySnapshot) => void

export interface SessionActivityFilter {
  chatId?: string
  agentId?: string
}

const copy = (item: SessionActivityItem): SessionActivityItem => ({
  ...item,
  startedAt: new Date(item.startedAt.getTime()),
  endedAt: item.endedAt && new Date(item.endedAt.getTime())
})

const sameItem = (a: SessionActivityItem, b: SessionActivityItem): boolean =>
  a.title === b.title && a.detail === b.detail && a.state === b.state && a.outputPath === b.outputPath &&
  a.canStop === b.canStop && a.agentId === b.agentId && a.kind === b.kind &&
  a.startedAt.getTime() === b.startedAt.getTime() && (a.endedAt?.getTime() ?? null) === (b.endedAt?.getTime() ?? null)

const order = (items: SessionActivityItem[]): SessionActivityItem[] => {
  const running = items.filter((item) => item.state === 'running')
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  const ended = items.filter((item) => item.state !== 'running')
    .sort((a, b) => b.endedAt!.getTime() - a.endedAt!.getTime())
  return [...running, ...ended]
}

/**
 * What a chat's agent session is running beside its turns, in memory only:
 * activity describes live processes, and a restart ends them all.
 *
 * **Retention, per chat and per kind.** At most `ENDED_PER_KIND` ended items of
 * a kind are kept, the most recently ended. When an item of a kind starts while
 * nothing of that kind is running, the ended items of that kind are dropped: they
 * belonged to the previous round, whose badge has already hidden. So while a
 * round runs the popover can say "2 finished, 1 running", and the finished ones
 * of a quiet kind stay only until that kind's next start.
 *
 * **Corrections.** A later terminal state replaces an earlier one (state,
 * `endedAt`, and the summary if one came). Nothing moves an ended item back to
 * running, and an end for an unknown id creates nothing.
 *
 * `onChange` fires once per effective change, with the chat's new snapshot.
 * Items are copied out; nothing held here is exposed by reference.
 */
export function createSessionActivityHub(now: () => Date = () => new Date()) {
  const chats = new Map<string, Map<string, SessionActivityItem>>()
  const lastChange = new Map<string, number>()
  const listeners = new Set<SessionActivityListener>()

  const snapshotOf = (chatId: string): SessionActivitySnapshot => ({
    chatId,
    items: order([...(chats.get(chatId)?.values() ?? [])]).map(copy)
  })

  const emit = (chatId: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(chatId, snapshotOf(chatId))
      } catch (error) {
        logger.warn('a session activity listener failed', { chatId, error: String(error) })
      }
    }
  }

  const trim = (items: Map<string, SessionActivityItem>, kind: SessionActivityKind): void => {
    const ended = order([...items.values()].filter((item) => item.kind === kind && item.state !== 'running'))
    for (const item of ended.slice(ENDED_PER_KIND)) items.delete(item.id)
  }

  /** Applies one change; answers whether anything visible changed. */
  const apply = (chatId: string, agentId: string, change: SessionActivityChange, at: Date): boolean => {
    let items = chats.get(chatId)
    const existing = items?.get(change.id)
    if (change.type === 'end') {
      if (!items || !existing) {
        logger.debug('an end for an unknown activity item was ignored', { chatId, agentId, id: change.id, state: change.state })
        return false
      }
      const next: SessionActivityItem = {
        ...existing, state: change.state, endedAt: at, canStop: false,
        detail: change.summary ?? existing.detail
      }
      // A repeated identical end is not a change, not even of endedAt.
      if (existing.state === change.state && next.detail === existing.detail) return false
      items.set(change.id, next)
      trim(items, existing.kind)
      return true
    }
    if (!existing) {
      if (!items) { items = new Map(); chats.set(chatId, items) }
      const kindRunning = [...items.values()].some((item) => item.kind === change.kind && item.state === 'running')
      if (!kindRunning) {
        for (const item of [...items.values()]) if (item.kind === change.kind) items.delete(item.id)
      }
      if (!change.title) logger.debug('an activity item started without a title', { chatId, agentId, id: change.id })
      items.set(change.id, {
        id: change.id, kind: change.kind, agentId, title: change.title || change.id,
        detail: change.detail ?? null, state: 'running', startedAt: at, endedAt: null,
        outputPath: change.outputPath ?? null, canStop: change.canStop ?? false
      })
      return true
    }
    const next: SessionActivityItem = {
      ...existing,
      title: change.title || existing.title,
      detail: change.detail ?? existing.detail,
      outputPath: change.outputPath ?? existing.outputPath,
      // Only a running item can be stopped.
      canStop: existing.state === 'running' ? change.canStop ?? existing.canStop : false
    }
    if (sameItem(existing, next)) return false
    items!.set(change.id, next)
    return true
  }

  const touch = (agentId: string, at: Date): void => { lastChange.set(agentId, at.getTime()) }

  return {
    report(chatId: string, agentId: string, change: SessionActivityChange): void {
      const at = now()
      if (!apply(chatId, agentId, change, at)) return
      touch(agentId, at)
      emit(chatId)
    },

    /** Ends every running item that matches, `lost` unless told otherwise. Ended items keep their state. */
    endAll(filter: SessionActivityFilter, state: SessionActivityTerminalState = 'lost'): void {
      const at = now()
      for (const [chatId, items] of [...chats]) {
        if (filter.chatId !== undefined && chatId !== filter.chatId) continue
        let changed = false
        for (const item of [...items.values()]) {
          if (item.state !== 'running' || (filter.agentId !== undefined && item.agentId !== filter.agentId)) continue
          apply(chatId, item.agentId, { type: 'end', id: item.id, state }, at)
          touch(item.agentId, at)
          changed = true
        }
        if (changed) emit(chatId)
      }
    },

    snapshot(chatId: string): SessionActivitySnapshot {
      return snapshotOf(chatId)
    },

    hasRunning(filter: SessionActivityFilter = {}): boolean {
      for (const [chatId, items] of chats) {
        if (filter.chatId !== undefined && chatId !== filter.chatId) continue
        for (const item of items.values()) {
          if (item.state === 'running' && (filter.agentId === undefined || item.agentId === filter.agentId)) return true
        }
      }
      return false
    },

    /** When an item of this agent last changed, in any chat; null if never. */
    lastChangeAt(agentId: string): Date | null {
      const at = lastChange.get(agentId)
      return at === undefined ? null : new Date(at)
    },

    onChange(listener: SessionActivityListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /** Forgets a chat (it was deleted). Announces the empty snapshot if it held anything. */
    clear(chatId: string): void {
      const items = chats.get(chatId)
      if (!items) return
      chats.delete(chatId)
      if (items.size) emit(chatId)
    }
  }
}

export type SessionActivityHub = ReturnType<typeof createSessionActivityHub>

export const sessionActivityHub = createSessionActivityHub()
