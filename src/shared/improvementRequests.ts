/**
 * Improvement Request — the user sends a frozen copy of one cloud conversation
 * with a bundle agent to whoever publishes that bundle, with a note on what
 * should change. cinna-core owns the snapshot, the recipient and the limits;
 * the desktop only picks which agent's session of this chat to send, and
 * main resolves that session's core id itself — the renderer never names it.
 *
 * Every answer, refusals included, is data: a thrown code never reaches the
 * renderer (`ipc/_wrap.ts`).
 */

/** cinna-core's own limit on the comment (`MAX_COMMENT_CHARS`). */
export const IMPROVEMENT_COMMENT_MAX = 4000

/** One agent of the chat whose cloud session can be sent. */
export interface ImprovementTarget {
  agentId: string
  agentName: string
  /** When this agent's session in the chat last moved (epoch ms), or null. */
  lastActivityAt: number | null
  /** The chat's own agent (the one it is bound to), listed first. */
  bound: boolean
}

/** core's pre-flight for one target: who would receive it, and whether it can be sent. */
export interface ImprovementContext {
  eligible: boolean
  /** core's machine reason when not eligible (`not_owner`, `empty_session`, …). */
  reason: string | null
  /** A sentence for {@link reason}; null when eligible. */
  reasonText: string | null
  isSharedExternally: boolean
  recipientDisplay: string | null
  targetAgentName: string | null
  bundleId: string | null
  installedVersion: string | null
  messageCount: number
  existingRequestCount: number
}

export interface ImprovementRequestInput {
  chatId: string
  agentId: string
  comment: string
  includeMemory: boolean
}

/** core's create answer carries no recipient; the dialog names it from the pre-flight. */
export interface ImprovementRequestCreated {
  id: string
}

export type ImprovementRefusalCode =
  /** The agent has no sendable cloud session in this chat (or the chat is not visible). */
  | 'no_target'
  /** Blank or over {@link IMPROVEMENT_COMMENT_MAX}. */
  | 'invalid_comment'
  /** The Cinna session is gone; the global sign-in prompt is raised too. */
  | 'reauth_required'
  /** The profile is not linked to a Cinna account. */
  | 'no_account'
  /** core said no (403/400/404/429); `message` is core's own sentence. */
  | 'refused'
  /** No answer, or one that could not be read. */
  | 'failed'

export type ImprovementOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; code: ImprovementRefusalCode; message: string }
