import { and, asc, eq, gt, gte, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { inflightTurns, messages } from './schema'
import { messageRepo } from './messages'
import type { MessagePart } from '../../shared/messageParts'

export type InflightTurnRow = typeof inflightTurns.$inferSelect

export interface OpenInflightTurn {
  /** The direct-chat wrapper's request id. */
  id: string
  profileId: string
  chatId: string
  agentId: string
  /** The agent's driver id — `a2a`, `managed`, `acp`, … */
  driver: string
  userMessageId: string | null
}

export interface WriteDraft {
  /** The turn's marker, when it has one; the draft's id is recorded on it. */
  markerId: string | null
  /** The draft row written before, or null for the first write. */
  draftId: string | null
  chatId: string
  agentId: string
  content: string
  parts: MessagePart[]
}

/** The error row a turn that cannot be finished ends with: a readable card, never a folded notice. */
export interface TurnEndNotice {
  /** The whole message: the row has no Details. */
  short: string
  /** Machine-readable reason, e.g. `turn_interrupted`. */
  code: string
}

/** One row of a recovered turn, in transcript order. */
export type RecoveredRow =
  | { role: 'agent_transition'; content: string }
  | { role: 'assistant'; content: string; parts: MessagePart[] }
  /** `detail` as `messageRepo.saveError` takes it: `short` when omitted, none when null. */
  | { role: 'error'; short: string; detail?: string | null; code?: string }

export interface TurnRowsOf {
  chatId: string
  agentId: string
  /** The user row the turn answers. */
  userMessageId: string
  /** The turn's draft row, when the marker names one. */
  draftMessageId: string | null
}

export interface ReplaceTurnRows extends TurnRowsOf {
  /** Go directly below the user row. */
  rows: RecoveredRow[]
}

/**
 * Markers this process opened for turns it is running. A marker is a record
 * of a turn the app was *closed* under only once its process is gone, so a
 * recovery pass or boot pass in the same process must leave these alone.
 * Dropped when the marker is deleted.
 */
const liveMarkerIds = new Set<string>()

/** Record that this process opened `id` for a turn it runs now. */
export function markLiveMarker(id: string): void {
  liveMarkerIds.add(id)
}

/** Whether `id` belongs to a turn this process is running (see {@link markLiveMarker}). */
export function isLiveMarker(id: string): boolean {
  return liveMarkerIds.has(id)
}

type UserRow = { sortOrder: number }

/** The turn's user row, or null when it is no longer a user row of the chat. */
function userRowOf(input: Pick<TurnRowsOf, 'chatId' | 'userMessageId'>): UserRow | null {
  const user = messageRepo.getById(input.userMessageId)
  return user && user.chatId === input.chatId && user.role === 'user' ? user : null
}

/**
 * The rows under the user row, up to the next user row, in order, with
 * whether each is the turn's own: the draft, and the agent's assistant and
 * notice rows. `nextUser` is the sort order of that next user row, if any.
 */
function rowsUnder(input: TurnRowsOf, user: UserRow): { rows: { id: string; ours: boolean; sortOrder: number }[]; nextUser: number | null } {
  const after = getDb().select({ id: messages.id, role: messages.role, sourceAgentId: messages.sourceAgentId, sortOrder: messages.sortOrder })
    .from(messages)
    .where(and(eq(messages.chatId, input.chatId), gt(messages.sortOrder, user.sortOrder)))
    .orderBy(asc(messages.sortOrder))
    .all()
  const rows: { id: string; ours: boolean; sortOrder: number }[] = []
  for (const row of after) {
    if (row.role === 'user') return { rows, nextUser: row.sortOrder }
    const ours = row.id === input.draftMessageId ||
      ((row.role === 'assistant' || row.role === 'agent_transition') && row.sourceAgentId === input.agentId)
    rows.push({ id: row.id, ours, sortOrder: row.sortOrder })
  }
  return { rows, nextUser: null }
}

/** An error row's content, as `messageRepo.saveError` writes it. */
function errorContent(row: { short: string; detail?: string | null; code?: string }): string {
  return JSON.stringify({
    short: row.short,
    ...(row.detail === null ? {} : { detail: row.detail ?? row.short }),
    ...(row.code ? { code: row.code } : {})
  })
}

/** Make room for `count` rows at `at`: every row of the chat from there moves down. */
function shiftFrom(chatId: string, at: number, count: number): void {
  getDb().update(messages)
    .set({ sortOrder: sql`${messages.sortOrder} + ${count}` })
    .where(and(eq(messages.chatId, chatId), gte(messages.sortOrder, at)))
    .run()
}

/** Thrown by {@link inflightTurnRepo.replaceTurnRows} when the turn's user row is no longer in the chat. */
export class TurnUserRowGone extends Error {
  constructor() {
    super('The turn’s user message is no longer in the chat.')
    this.name = 'TurnUserRowGone'
  }
}

/**
 * Durable record of the direct-chat turns that are running right now, and of
 * the one assistant row ("draft") each keeps up to date while it runs.
 */
export const inflightTurnRepo = {
  open(input: OpenInflightTurn): void {
    getDb().insert(inflightTurns).values({ ...input, draftMessageId: null, startedAt: new Date() }).run()
  },

  get(id: string): InflightTurnRow | null {
    return getDb().select().from(inflightTurns).where(eq(inflightTurns.id, id)).get() ?? null
  },

  /** Every marker, oldest first — across profiles, for the boot pass. */
  list(): InflightTurnRow[] {
    return getDb().select().from(inflightTurns).orderBy(inflightTurns.startedAt).all()
  },

  listChatIds(): Set<string> {
    return new Set(getDb().select({ chatId: inflightTurns.chatId }).from(inflightTurns).all().map((row) => row.chatId))
  },

  setDraft(id: string, draftMessageId: string | null): void {
    getDb().update(inflightTurns).set({ draftMessageId }).where(eq(inflightTurns.id, id)).run()
  },

  delete(id: string): void {
    getDb().delete(inflightTurns).where(eq(inflightTurns.id, id)).run()
    liveMarkerIds.delete(id)
  },

  /**
   * Settle a marker the app was killed under: save `notice` (if any) as an
   * error row and delete the marker, in one transaction, so a boot that fails
   * halfway writes neither and the next one tries again. Neither moves the
   * chat in the list.
   *
   * The notice goes at the chat's end, unless `under` names the turn's user
   * row and a later user row follows it: then it goes directly under the
   * turn's own rows, above what the chat has moved on to.
   */
  settle(marker: Pick<InflightTurnRow, 'id' | 'chatId' | 'agentId'> & { draftMessageId?: string | null },
    notice?: TurnEndNotice, options: { under?: string | null } = {}): void {
    getDb().transaction(() => {
      if (notice) {
        const placed = options.under
          ? inflightTurnRepo.insertUnderTurn({
              chatId: marker.chatId, agentId: marker.agentId, userMessageId: options.under,
              draftMessageId: marker.draftMessageId ?? null
            }, notice)
          : false
        if (!placed) messageRepo.saveError({ chatId: marker.chatId, short: notice.short, detail: null, code: notice.code })
      }
      inflightTurnRepo.delete(marker.id)
    })
  },

  /** Whether the turn's user row is still a user row of the chat. */
  hasUserRow(input: Pick<TurnRowsOf, 'chatId' | 'userMessageId'>): boolean {
    return userRowOf(input) !== null
  },

  /**
   * Whether the chat has moved on past the turn: a user row follows its user
   * row. False when the user row is gone.
   */
  hasLaterUserRow(input: Pick<TurnRowsOf, 'chatId' | 'userMessageId'>): boolean {
    const user = userRowOf(input)
    if (!user) return false
    return !!getDb().select({ id: messages.id }).from(messages)
      .where(and(eq(messages.chatId, input.chatId), gt(messages.sortOrder, user.sortOrder), eq(messages.role, 'user')))
      .get()
  },

  /**
   * The ids {@link replaceTurnRows} would delete for this turn, in order.
   * Empty when the user row is gone.
   */
  turnRowIds(input: TurnRowsOf): string[] {
    const user = userRowOf(input)
    if (!user) return []
    return rowsUnder(input, user).rows.filter((row) => row.ours).map((row) => row.id)
  },

  /**
   * Insert a notice's error row directly under the turn's own rows (or under
   * its user row when it has none), moving what follows down. False, and
   * nothing written, when the user row is gone or no later user row follows
   * it — the chat's end is then the same place.
   */
  insertUnderTurn(input: TurnRowsOf, notice: TurnEndNotice): boolean {
    const user = userRowOf(input)
    if (!user) return false
    const { rows, nextUser } = rowsUnder(input, user)
    if (nextUser === null) return false
    const at = (rows.filter((row) => row.ours).at(-1)?.sortOrder ?? user.sortOrder) + 1
    shiftFrom(input.chatId, at, 1)
    getDb().insert(messages).values({
      id: nanoid(), chatId: input.chatId, sortOrder: at, createdAt: new Date(),
      role: 'error', content: errorContent({ ...notice, detail: null })
    }).run()
    return true
  },

  /**
   * Replace what a killed turn left in the transcript with `rows`, in one
   * transaction. Deleted: the rows between the user row and the next user row
   * that are this turn's — the draft, and the agent's assistant and notice
   * rows a quit flush saved. `rows` go directly below the user row; anything
   * that already follows it (a message sent while the turn was recovered)
   * moves down to make room. Returns the new rows' ids, in order. Throws when
   * the user row is not in the chat.
   */
  replaceTurnRows(input: ReplaceTurnRows): string[] {
    const db = getDb()
    return db.transaction(() => {
      const user = userRowOf(input)
      if (!user) throw new TurnUserRowGone()
      const doomed = rowsUnder(input, user).rows.filter((row) => row.ours).map((row) => row.id)
      if (doomed.length) db.delete(messages).where(inArray(messages.id, doomed)).run()
      const count = input.rows.length
      if (!count) return []
      shiftFrom(input.chatId, user.sortOrder + 1, count)
      const now = new Date()
      return input.rows.map((row, index) => {
        const base = { id: nanoid(), chatId: input.chatId, sortOrder: user.sortOrder + 1 + index, createdAt: now }
        if (row.role === 'error') {
          db.insert(messages).values({
            ...base,
            role: 'error',
            content: errorContent(row)
          }).run()
        } else {
          db.insert(messages).values({
            ...base,
            role: row.role,
            content: row.content,
            parts: row.role === 'assistant' ? row.parts : null,
            sourceAgentId: input.agentId
          }).run()
        }
        return base.id
      })
    })
  },

  /**
   * Insert the draft row (first write, returning its new id and recording it
   * on the marker) or rewrite it in place. One transaction.
   */
  writeDraft(input: WriteDraft): string {
    return getDb().transaction(() => {
      if (input.draftId) {
        messageRepo.updateAssistantParts(input.draftId, input.content, input.parts)
        return input.draftId
      }
      const id = messageRepo.saveAssistant({
        chatId: input.chatId, content: input.content, parts: input.parts, sourceAgentId: input.agentId
      })
      if (input.markerId) inflightTurnRepo.setDraft(input.markerId, id)
      return id
    })
  },

  /**
   * Drop the draft row and clear it from the marker, then run `write` — the
   * turn's real rows — in the same transaction, so the transcript never holds
   * both, or neither.
   */
  replaceDraft(markerId: string | null, draftId: string | null, write: () => void): void {
    getDb().transaction(() => {
      if (draftId) messageRepo.deleteById(draftId)
      if (markerId && draftId) inflightTurnRepo.setDraft(markerId, null)
      write()
    })
  }
}
