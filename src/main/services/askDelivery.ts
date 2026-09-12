import { chatRepo } from '../db/chats'
import { driverFor, respondToOrphanedAsk } from '../agents/drivers'
import { agentService } from './agentService'
import { pendingRequests } from '../agents/drivers/pendingRequests'
import { getSettingsScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import type { PermissionReply, RequestResolution } from '../../shared/localAgentRequests'
import { ASK_NO_LONGER_WAITING } from '../../shared/inbox'
import type { AskAnswerPayload, InboxAnswerResult } from '../../shared/inbox'

const logger = createLogger('ask')

/** OpenCode's `PermissionV2Reply`, checked at the boundary rather than cast. */
function isPermissionReply(value: unknown): value is PermissionReply {
  return value === 'once' || value === 'always' || value === 'reject'
}

/** `QuestionV2Reply.answers` — one array of selected labels **per question**. */
function isAnswerMatrix(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((s) => typeof s === 'string'))
  )
}

/**
 * The renderer's answer payload, narrowed to a {@link RequestResolution}, or
 * null when it is neither.
 *
 * Validated at the boundary rather than trusted, and against the *engine's*
 * enum rather than against TypeScript's belief about it. A renderer bug or a
 * stale preload would otherwise send `'allow'`, or a flat `string[]`, and the
 * first anyone would know is a 400 the driver logs at warn while the dialog has
 * already told the user their answer landed.
 *
 * Both surfaces that answer an ask — the transcript's block and the inbox —
 * send this shape and parse it here, so neither can grow its own idea of what a
 * valid answer is.
 */
export function parseAnswerPayload(data: AskAnswerPayload): RequestResolution | null {
  if (isPermissionReply(data.reply)) return { kind: 'permission', reply: data.reply }
  if (isAnswerMatrix(data.answers)) return { kind: 'question', answers: data.answers }
  return null
}

/**
 * Deliver a user's answer to a run that is parked on it.
 *
 * **One function for two surfaces.** The transcript's own permission block
 * answers through `agent:answer-request`, and the inbox answers the same ask
 * with the chat closed through `inbox:answer` — the same address, the same
 * ownership rules, the same rule-writing side effect. They were one handler
 * until the inbox needed it too, and the thing that must not drift between them
 * is what *Always allow* means: the rule is written beside the agent and the
 * engine is told `once` (`localAgentRequests.ts` documents why).
 *
 * What stays with the callers is only the channel and the activation check:
 * both narrow their payload through {@link parseAnswerPayload} first.
 *
 * **Everything from `owner()` to `respond()` is synchronous, and it has to stay
 * so.** `respond` writes the rule before it settles the park, and the settle can
 * still find nothing waiting — the turn was cancelled in between. Nothing can
 * interleave today; an `await` inserted anywhere on this path makes it real.
 *
 * Returns data, never throws: every outcome here is something the user reads.
 */
export function deliverAnswer(
  userId: string,
  requestId: string,
  resolution: RequestResolution
): InboxAnswerResult {
  const owner = pendingRequests.owner(requestId)
  // An unknown request is the ordinary outcome of answering an ask whose turn
  // has since been cancelled — the user is looking at a stale block, or at an
  // inbox row the park timeout has already rejected for them — so it is
  // reported plainly rather than logged as a fault.
  if (!owner) return { ok: false, reason: ASK_NO_LONGER_WAITING, code: 'no_longer_waiting' }

  if (!chatRepo.getOwned(userId, owner.chatId)) {
    logger.warn('answer rejected: the caller does not own that chat', { requestId })
    return { ok: false, reason: 'Chat not found', code: 'not_owned' }
  }

  // The registry knows what was asked; the answer says what kind it is. A
  // permission answer posted to a question id would be delivered to the wrong
  // endpoint and refused by the engine — but only after the dialog that sent it
  // had already told the user it worked. `{kind: 'rejected'}` never matches
  // either kind, which is deliberate: it is how the *registry* settles an
  // abandoned ask, not an answer a person can give.
  if (resolution.kind !== owner.kind) {
    logger.warn('an answer was rejected as mismatched', {
      requestId,
      expected: owner.kind,
      got: resolution.kind
    })
    return { ok: false, reason: 'Malformed answer', code: 'malformed' }
  }

  // **A turn can outlive its row.** Removing an agents folder prunes the rows of
  // every agent in it without waiting for the turn lock, so an ask can still be
  // parked on an agent `findAgent` no longer knows. The answer is delivered
  // anyway — refusing it would leave the turn stuck until the park times out —
  // with no rule written, since there is no agent left to keep one beside:
  // `always` goes through as `once`, `remembered: false`.
  const located = agentService.findAgent(getSettingsScopeUserId(), userId, owner.agentId)
  if (!located) {
    logger.warn('an answer arrived for an agent whose row is gone; delivering it without a rule', {
      requestId,
      agentId: owner.agentId
    })
  }

  const ask = { requestId, ...owner }
  const outcome = located
    ? driverFor(located.row).respond(ask, resolution)
    : respondToOrphanedAsk(ask, resolution)

  if (!outcome.delivered) {
    return { ok: false, reason: ASK_NO_LONGER_WAITING, code: 'no_longer_waiting' }
  }
  return {
    ok: true,
    // Present only for a permission answered *always*: the block reads it to
    // decide between "remembered for this agent" and "allowed once — the rule
    // could not be saved".
    ...(outcome.remembered !== undefined ? { remembered: outcome.remembered } : {})
  }
}
