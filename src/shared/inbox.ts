/**
 * The Inbox — one list of everything waiting on a human.
 *
 * A local driver parking a run (an ACP permission ask, a question) and — from
 * step 9 of the phase — a bound remote system reporting a session that went
 * `blocked` arrive here as the **same** entry, because both carry an
 * `InputRequest` from `shared/runEvents.ts`. That is plan rule 1 applied one
 * level up: the transcript renders an ask with one component, and so does the
 * inbox, because there is only ever one type to render.
 *
 * Pure type module: imported from main, preload and the renderer alike.
 */
import type { PermissionReply } from './localAgentRequests'
import type { InputRequest, InputResumeMode } from './runEvents'

/**
 * Where an entry came from.
 *
 *  - `local` — a run parked on this machine. Answered through the driver that
 *    parked it, by request id.
 *  - `remote` — an open ask on a bound remote system. Answered through its
 *    adapter. **Nothing produces one yet**; the arm is here because the entry
 *    the renderer binds to must not change shape when step 9 lands.
 */
export type InboxSource = 'local' | 'remote'

/** One thing waiting for the user. */
export interface InboxEntry {
  /** The address an answer is posted to. Unique across the inbox. */
  requestId: string
  source: InboxSource
  taskId: string
  /** The task's title, so a row reads as a sentence without a second query. */
  taskTitle: string
  /**
   * The chat the ask came from. Present for a local entry — it is what "open
   * the conversation" links to — and null for a remote one, whose thread lives
   * on the other side.
   */
  chatId: string | null
  /** Who is asking. A display hint: the renderer resolves the name from its own agent list. */
  agentId: string | null
  request: InputRequest
  resume: InputResumeMode
  createdAt: Date
}

/**
 * What a surface sends to answer an ask.
 *
 * Deliberately the engine's own vocabulary rather than a `RequestResolution`:
 * this is what a renderer control produces (one of three permission replies, or
 * a selection per question), and narrowing it happens in one place in the main
 * process (`askDelivery.parseAnswerPayload`). Exactly one of the two fields is
 * set; neither, or both, is a malformed answer.
 */
export interface AskAnswerPayload {
  requestId: string
  reply?: PermissionReply
  answers?: string[][]
}

/**
 * Why an answer did not land.
 *
 * Carried beside the sentence so a surface can branch on intent without
 * matching copy — the same reason `RunErrorEvent` has a `code`. It travels as
 * **data** on the result, not on a thrown error, because a `DomainError`'s code
 * does not survive `ipcMain.handle` + `contextBridge` (see `_wrap.ts`).
 *
 *  - `no_longer_waiting` — the address died: the turn ended, the park timed
 *    out, the app restarted under it. The ask is gone, not refused.
 *  - `already_answered` — somebody got there first (the transcript, another
 *    window, the engine itself).
 *  - `not_here` — the ask is answered by writing in its chat, not from here.
 *  - `not_owned` — the ask belongs to a chat this profile does not own.
 *  - `malformed` — the answer was not a shape the ask accepts.
 */
export type InboxAnswerCode =
  | 'no_longer_waiting'
  | 'already_answered'
  | 'not_here'
  | 'not_owned'
  | 'malformed'

/** An answer to an ask whose turn has since ended — a stale block, not a fault. */
export const ASK_NO_LONGER_WAITING = 'This request is no longer waiting for an answer.'

/**
 * What answering produced.
 *
 * Returned as **data, never thrown**: a `DomainError`'s `code` does not survive
 * `ipcMain.handle` + `contextBridge` (see `src/main/ipc/_wrap.ts`), and every
 * failure here is a thing the user needs to read rather than a fault — the ask
 * timed out, the turn was cancelled, someone else answered it first.
 */
export interface InboxAnswerResult {
  ok: boolean
  /** Why not, in words meant for the user. Present exactly when `ok` is false. */
  reason?: string
  /** The same refusal, for code to read. Present exactly when `ok` is false. */
  code?: InboxAnswerCode
  /**
   * Present only for a permission answered *always*: whether the rule reached
   * disk. False means the action went ahead and will be asked about again.
   */
  remembered?: boolean
}
