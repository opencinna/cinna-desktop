/**
 * Vault chats' transcripts in memory (D30). `messageRepo`, `inflightTurnRepo`
 * and `chatRepo`'s message reads route a chat with `chats.vault_id` here, so
 * SQLite never sees a vault chat's content: no `messages` row, no FTS entry,
 * no `inflight_turns` marker (D23).
 *
 * What it emulates for those callers: rows with the `messages` columns, ids
 * the caller gets back, `sortOrder` as max + 1 per chat, ordering by
 * `sortOrder`, in-place updates, deletes, shifting rows down to make room, and
 * the in-flight marker of a running turn. What it does not: transactions
 * (every call here is synchronous, so a repo "transaction" is one call and
 * cannot interleave; nothing is rolled back if a later step throws),
 * cross-chat queries (stats, search, agent lists: vault chats are absent from
 * them), and recovery (markers and drafts are memory-only, never journaled,
 * so a vault turn the app dies under is simply gone).
 *
 * Every other row change is journaled as a {@link TranscriptOp} through the
 * installed {@link TranscriptSink} (`transcript.append` in the guest). The
 * vault service rebuilds a vault's chats from the journal on unlock
 * ({@link openVault}) and drops them on lock ({@link closeVault}).
 *
 * A chat whose turn is still running when its vault locks (Lock now, the
 * screen locking mid-stream) is not dropped at once: it stays as a
 * **detached** transcript until that turn has finished writing, so the
 * reply's rows go to the journal queue (delivered, in order, after the next
 * unlock) instead of failing the turn. Nothing reaches SQLite either way.
 */
import type { TranscriptOp, TranscriptRow } from '../../shared/vault/protocol'
import type { MessageRow } from '../db/messages'
import type { InflightTurnRow } from '../db/inflightTurns'

/** Where a vault chat's row ops go. Must not throw; it is called inside repository writes. */
export interface TranscriptSink {
  append(vaultId: string, chatId: string, ops: TranscriptOp[]): void
  /**
   * Whether everything appended for `chatId` so far reached the vault:
   * `saved`, `pending` (still queued after `timeoutMs`, e.g. the vault is
   * locked: it is retried), or `failed` (it never will: the vault is gone or
   * refused it). Absent: `saved`.
   */
  settled?(vaultId: string, chatId: string, timeoutMs: number): Promise<JournalOutcome>
}

export type JournalOutcome = 'saved' | 'pending' | 'failed'

/** What the user reads when a vault turn's rows could not be journaled. */
export const VAULT_REPLY_NOT_SAVED = 'This reply could not be saved in the vault.'

/** Thrown by a write to a vault chat whose vault is locked: the row would have nowhere to go. */
export class VaultTranscriptLocked extends Error {
  readonly code = 'vault_locked'
  constructor() {
    super('This chat is in a vault that is locked. Unlock it to continue.')
    this.name = 'VaultTranscriptLocked'
  }
}

const DATE_KEYS = new Set(['createdAt', 'startedAt'])

/** A row as journaled: Dates as epoch ms. */
export function toJournalRow(row: Record<string, unknown> & { id: string }): TranscriptRow {
  const out: TranscriptRow = { id: row.id }
  for (const [key, value] of Object.entries(row)) out[key] = value instanceof Date ? value.getTime() : value
  return out
}

function fromJournalRow<T>(row: TranscriptRow): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key] = DATE_KEYS.has(key) && typeof value === 'number' ? new Date(value) : value
  return out as T
}

function copy<T extends object>(row: T): T {
  return { ...row }
}

export class ChatTranscript {
  private rows: MessageRow[] = []
  private readonly byId = new Map<string, MessageRow>()
  /** Draft rows of running turns: memory-only, never journaled. */
  private readonly ephemeral = new Set<string>()
  readonly markers = new Map<string, InflightTurnRow>()

  constructor(readonly chatId: string, readonly vaultId: string, private readonly journal: (ops: TranscriptOp[]) => void) {}

  // -- reads ---------------------------------------------------------------

  list(): MessageRow[] {
    return this.rows.map(copy)
  }

  get(id: string): MessageRow | undefined {
    const row = this.byId.get(id)
    return row ? copy(row) : undefined
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  nextSortOrder(): number {
    const last = this.rows.at(-1)
    return last ? last.sortOrder + 1 : 0
  }

  // -- writes --------------------------------------------------------------

  /** Insert a whole row. `sortOrder` must be set; `ephemeral` keeps it out of the journal. */
  insert(row: MessageRow, options: { ephemeral?: boolean } = {}): void {
    if (this.byId.has(row.id)) throw new Error('A message with that id already exists.')
    const stored = copy(row)
    this.byId.set(stored.id, stored)
    this.rows.push(stored)
    this.sort()
    if (options.ephemeral) this.ephemeral.add(stored.id)
    else this.journal([{ op: 'put', table: 'messages', row: toJournalRow(stored) }])
  }

  /** Update one row in place when `where` holds; returns whether it changed. */
  update(id: string, patch: Partial<MessageRow>, where: (row: MessageRow) => boolean = () => true): boolean {
    const row = this.byId.get(id)
    if (!row || !where(row)) return false
    Object.assign(row, patch, { id: row.id, chatId: row.chatId })
    if ('sortOrder' in patch) this.sort()
    if (!this.ephemeral.has(id)) this.journal([{ op: 'put', table: 'messages', row: toJournalRow(row) }])
    return true
  }

  delete(id: string): boolean {
    const row = this.byId.get(id)
    if (!row) return false
    this.byId.delete(id)
    this.rows = this.rows.filter((candidate) => candidate.id !== id)
    if (this.ephemeral.delete(id)) return true
    this.journal([{ op: 'delete', table: 'messages', id }])
    return true
  }

  /** Every row at or after `at` moves down by `count` (`inflightTurns.shiftFrom`). */
  shiftFrom(at: number, count: number): void {
    const ops: TranscriptOp[] = []
    for (const row of this.rows) {
      if (row.sortOrder < at) continue
      row.sortOrder += count
      if (!this.ephemeral.has(row.id)) ops.push({ op: 'put', table: 'messages', row: toJournalRow(row) })
    }
    this.sort()
    if (ops.length) this.journal(ops)
  }

  // -- replay --------------------------------------------------------------

  /** Apply journaled ops (unlock), without journaling them again. */
  replay(ops: readonly TranscriptOp[]): void {
    for (const op of ops) {
      if (op.op === 'chat' || op.table !== 'messages') continue
      if (op.op === 'delete') {
        if (this.byId.delete(op.id)) this.rows = this.rows.filter((row) => row.id !== op.id)
        continue
      }
      const row = fromJournalRow<MessageRow>(op.row)
      if (typeof row.id !== 'string' || row.chatId !== this.chatId) continue
      const existing = this.byId.get(row.id)
      if (existing) {
        Object.assign(existing, row)
      } else {
        this.byId.set(row.id, row)
        this.rows.push(row)
      }
    }
    this.sort()
  }

  private sort(): void {
    this.rows.sort((a, b) => a.sortOrder - b.sortOrder)
  }
}

const noSink: TranscriptSink = { append: () => {} }
let sink: TranscriptSink = noSink

/** Vault id → the chats it holds while unlocked. */
const openVaults = new Map<string, Map<string, ChatTranscript>>()
/**
 * Chat id → the transcript of a turn that was running when its vault locked.
 * Kept only until that turn's last marker is gone (plus {@link DETACHED_GRACE_MS}
 * for the writes a turn makes after its marker: the error row, the cursor), or
 * the vault's next unlock, which takes it over.
 */
const detached = new Map<string, ChatTranscript>()
const detachedTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DETACHED_GRACE_MS = 30_000
const closeListeners = new Set<(vaultId: string) => void>()

function dropDetachedLater(chat: ChatTranscript): void {
  clearTimeout(detachedTimers.get(chat.chatId))
  const timer = setTimeout(() => {
    detachedTimers.delete(chat.chatId)
    if (detached.get(chat.chatId) === chat && chat.markers.size === 0) detached.delete(chat.chatId)
  }, DETACHED_GRACE_MS)
  timer.unref?.()
  detachedTimers.set(chat.chatId, timer)
}

function forgetDetached(chatId: string): void {
  clearTimeout(detachedTimers.get(chatId))
  detachedTimers.delete(chatId)
  detached.delete(chatId)
}

/** Every transcript a row or marker id may be in: the open vaults', then the detached ones. */
function* allTranscripts(): Iterable<ChatTranscript> {
  for (const chats of openVaults.values()) yield* chats.values()
  yield* detached.values()
}

function transcriptOf(vaultId: string, chats: Map<string, ChatTranscript>, chatId: string): ChatTranscript {
  let chat = chats.get(chatId)
  if (!chat) {
    chat = new ChatTranscript(chatId, vaultId, (ops) => {
      try {
        sink.append(vaultId, chatId, ops)
      } catch {
        // a sink must not throw; a failing one loses the op, never the turn
      }
    })
    chats.set(chatId, chat)
  }
  return chat
}

export const vaultTranscripts = {
  installSink(next: TranscriptSink | null): void {
    sink = next ?? noSink
  },

  /** The vault unlocked: its chats are rebuilt from their journals. A vault already open is rebuilt. */
  openVault(vaultId: string, journals: readonly { chatId: string; ops: readonly TranscriptOp[] }[] = []): void {
    const chats = new Map<string, ChatTranscript>()
    // A turn that outlived the last lock keeps its transcript: it already
    // holds every journaled row plus the running turn's draft and marker.
    for (const [chatId, kept] of [...detached]) {
      if (kept.vaultId !== vaultId) continue
      forgetDetached(chatId)
      chats.set(chatId, kept)
    }
    for (const { chatId, ops } of journals) {
      if (!chats.has(chatId)) transcriptOf(vaultId, chats, chatId).replay(ops)
    }
    openVaults.set(vaultId, chats)
  },

  /**
   * The vault locked: everything it held leaves memory, except the chats of
   * turns still running, which stay detached until those turns finish writing.
   */
  closeVault(vaultId: string): void {
    const chats = openVaults.get(vaultId)
    if (!chats) return
    openVaults.delete(vaultId)
    for (const chat of chats.values()) {
      if (chat.markers.size > 0) detached.set(chat.chatId, chat)
    }
    for (const listener of closeListeners) listener(vaultId)
  },

  /**
   * A marker of `chat` was deleted (`inflightTurnRepo.delete`): a detached
   * transcript whose last turn ended is dropped after a short grace.
   */
  markerDeleted(chat: ChatTranscript): void {
    if (detached.get(chat.chatId) === chat && chat.markers.size === 0) dropDetachedLater(chat)
  },

  /** See {@link TranscriptSink.settled}. */
  settled(vaultId: string, chatId: string, timeoutMs = 10_000): Promise<JournalOutcome> {
    return sink.settled ? sink.settled(vaultId, chatId, timeoutMs).catch((): JournalOutcome => 'failed') : Promise.resolve('saved')
  },

  isOpen(vaultId: string): boolean {
    return openVaults.has(vaultId)
  },

  onClose(listener: (vaultId: string) => void): () => void {
    closeListeners.add(listener)
    return () => closeListeners.delete(listener)
  },

  /**
   * The chat's transcript while its vault is open (an empty one for a chat
   * with no rows yet), or the detached one of a turn that outlived a lock;
   * null otherwise.
   */
  chat(chatId: string, vaultId: string): ChatTranscript | null {
    const chats = openVaults.get(vaultId)
    if (chats) return transcriptOf(vaultId, chats, chatId)
    const kept = detached.get(chatId)
    return kept && kept.vaultId === vaultId ? kept : null
  },

  /**
   * The chat's transcript for a **read** that answers anyone but the turn
   * writing it (chat:get, the message list, content lookups): only while its
   * vault is open. A detached transcript holds every row of a vault that is
   * now locked; it exists for its finishing turn's writes alone, so to every
   * reader it is as locked as the vault.
   */
  readable(chatId: string, vaultId: string): ChatTranscript | null {
    const chats = openVaults.get(vaultId)
    return chats ? transcriptOf(vaultId, chats, chatId) : null
  },

  /** Whether `chatId` is held detached (a turn that outlived its vault's lock). */
  isDetached(chatId: string): boolean {
    return detached.has(chatId)
  },

  /** {@link chat}, or throws {@link VaultTranscriptLocked}: for writes, which must never fall through to SQLite. */
  requireChat(chatId: string, vaultId: string): ChatTranscript {
    const chat = this.chat(chatId, vaultId)
    if (!chat) throw new VaultTranscriptLocked()
    return chat
  },

  /** The open (or detached) transcript holding message `id`, for the repo **writes** that name a row only. */
  byMessageId(id: string): ChatTranscript | null {
    for (const chat of allTranscripts()) if (chat.has(id)) return chat
    return null
  },

  /**
   * For a **read** by row id: the open transcript holding `id`; `'locked'`
   * when only a detached one holds it (see {@link readable}); null when no
   * vault transcript does (an ordinary chat's row).
   */
  readableByMessageId(id: string): ChatTranscript | 'locked' | null {
    for (const chats of openVaults.values()) for (const chat of chats.values()) if (chat.has(id)) return chat
    for (const chat of detached.values()) if (chat.has(id)) return 'locked'
    return null
  },

  /** The open (or detached) transcript holding in-flight marker `id`. */
  byMarkerId(id: string): ChatTranscript | null {
    for (const chat of allTranscripts()) if (chat.markers.has(id)) return chat
    return null
  },

  /** Chats with a running vault turn. */
  markerChatIds(): string[] {
    const out: string[] = []
    for (const chat of allTranscripts()) if (chat.markers.size > 0) out.push(chat.chatId)
    return out
  },

  /** Test seam. */
  resetForTest(): void {
    openVaults.clear()
    for (const chatId of [...detached.keys()]) forgetDetached(chatId)
    sink = noSink
  }
}

/** A sink that keeps every op in memory, per vault and chat. For tests and the fake lane. */
export function memoryTranscriptSink(): TranscriptSink & { ops(vaultId: string, chatId: string): TranscriptOp[]; journals(vaultId: string): { chatId: string; ops: TranscriptOp[] }[] } {
  const store = new Map<string, Map<string, TranscriptOp[]>>()
  return {
    append(vaultId, chatId, ops) {
      let chats = store.get(vaultId)
      if (!chats) store.set(vaultId, (chats = new Map()))
      chats.set(chatId, [...(chats.get(chatId) ?? []), ...ops.map((op) => JSON.parse(JSON.stringify(op)) as TranscriptOp)])
    },
    ops: (vaultId, chatId) => store.get(vaultId)?.get(chatId) ?? [],
    journals: (vaultId) => [...(store.get(vaultId) ?? new Map<string, TranscriptOp[]>()).entries()].map(([chatId, ops]) => ({ chatId, ops }))
  }
}
